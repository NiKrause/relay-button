import * as Signer from '@ucanto/principal/ed25519';
import * as AggregatorCaps from '@storacha/capabilities/filecoin/aggregator';
import {
  getConnection,
  getMockService,
  getStoreImplementations as getFilecoinStoreImplementations,
  getQueueImplementations as getFilecoinQueueImplementations,
} from '@storacha/filecoin-api/test/context/service';
import * as Email from '../../utils/email.js';
import { create as createRevocationChecker } from '../../utils/revocation.js';
import { createServer, connect } from '../../lib.js';
import { confirmConfirmationUrl } from './utils.js';
import { getServiceStorageImplementations } from '../storage/index.js';
import { getExternalServiceImplementations } from '../external-service/index.js';
import { createServiceIdentity } from './ucan-store-service-identity.js';

export const createContext = async (options = { requirePaymentPlan: false }) => {
  const requirePaymentPlan = options.requirePaymentPlan;
  const { id: serviceSigner } = await createServiceIdentity(process.env);
  const aggregatorSigner = await Signer.generate();
  const dealTrackerSigner = await Signer.generate();
  const service = getMockService();
  const aggregatorServiceProof = await AggregatorCaps.pieceOffer.delegate({
    issuer: aggregatorSigner,
    audience: serviceSigner,
    with: aggregatorSigner.did(),
    expiration: Infinity,
  });
  const dealTrackerConnection = getConnection(dealTrackerSigner, service).connection;
  const serviceStores = await getServiceStorageImplementations(options);
  const queuedMessages = new Map();
  const {
    storefront: { filecoinSubmitQueue, pieceOfferQueue },
  } = getFilecoinQueueImplementations(queuedMessages);
  const {
    storefront: { pieceStore, receiptStore, taskStore },
  } = getFilecoinStoreImplementations();
  const email = Email.debug();
  const externalServices = await getExternalServiceImplementations({
    ...options,
    serviceID: serviceSigner,
  });
  const serviceContext = {
    id: serviceSigner,
    signer: serviceSigner,
    email,
    requirePaymentPlan,
    url: new URL('http://localhost:8787'),
    ...serviceStores,
    ...externalServices,
    getServiceConnection: () => connection,
    ...createRevocationChecker({
      revocationsStorage: serviceStores.revocationsStorage,
    }),
    errorReporter: {
      catch(error) {
        if (options.assert) {
          options.assert.fail(error);
        } else {
          throw error;
        }
      },
    },
    filecoinSubmitQueue,
    pieceOfferQueue,
    pieceStore,
    receiptStore,
    taskStore,
    aggregatorInvocationConfig: {
      issuer: serviceSigner,
      with: serviceSigner.did(),
      audience: aggregatorSigner,
      proofs: [aggregatorServiceProof],
    },
    dealTrackerService: {
      connection: dealTrackerConnection,
      invocationConfig: {
        issuer: serviceSigner,
        with: serviceSigner.did(),
        audience: dealTrackerSigner,
      },
    },
    maxUploadSize: 5_000_000_000,
  };
  const connection = connect({
    id: serviceContext.id,
    channel: createServer(serviceContext),
  });
  return {
    ...serviceContext,
    ...serviceStores,
    ...externalServices,
    mail: serviceContext.email,
    service: serviceContext.id,
    connection,
    grantAccess: (mail) => confirmConfirmationUrl(connection, mail),
    fetch,
  };
};

export const cleanupContext = (context) =>
  Promise.all([
    context.carStoreBucket.deactivate(),
    context.blobsStorage.deactivate(),
    context.indexingService.deactivate(),
    context.claimsService.deactivate(),
    ...context.storageProviders.map((provider) => provider.deactivate()),
  ]);
