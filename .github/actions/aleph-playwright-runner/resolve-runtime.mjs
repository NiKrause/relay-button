import { appendFile } from "node:fs/promises";

const host = process.env.RUNNER_HOST?.trim();
const mapped = JSON.parse(process.env.MAPPED_PORTS_JSON || "{}");
const sshPort = Number(mapped["22"]?.host);
const tlsPort = Number(mapped["443"]?.host);
const caCertPath = process.env.CA_CERT_PATH?.trim();
if (
  !host ||
  !Number.isInteger(sshPort) ||
  !Number.isInteger(tlsPort) ||
  !caCertPath
) {
  throw new Error(
    "Deployment must return host IPv4 plus exact SSH and TLS port mappings",
  );
}
const origin = `https://${host}:${tlsPort}`;
await appendFile(
  process.env.GITHUB_OUTPUT,
  `ssh_port=${sshPort}\ntls_port=${tlsPort}\nws_endpoint=${origin.replace(/^https:/u, "wss:")}\nversion_url=${origin}/version\nca_cert_path=${caCertPath}\n`,
);
