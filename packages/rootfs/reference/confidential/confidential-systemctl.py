#!/usr/bin/python3
"""systemctl for a confidential rootfs: timers here, everything else in
docker-systemctl-replacement.

docker-systemctl-replacement does not run .timer units ("start not
implemented for unit type"), but the relay profiles start and enable timers in
their configure scripts, under `set -e`. This wrapper handles start, restart,
stop, enable, disable, is-active, is-enabled and status for .timer units: each
started timer is a small background loop that starts its service after
OnBootSec / OnActiveSec and then every OnUnitActiveSec, with
RandomizedDelaySec. All other calls go to the replacement unchanged.
"""

import os
import random
import re
import signal
import subprocess
import sys
import time

REAL = "/usr/lib/confidential/systemctl3.py"
UNIT_DIRS = ["/etc/systemd/system", "/run/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"]
WANTS = "/etc/systemd/system/timers.target.wants"
RUN_DIR = "/run/confidential-timers"
UNITS = {"us": 1e-6, "ms": 1e-3, "s": 1, "sec": 1, "second": 1, "seconds": 1, "m": 60, "min": 60,
         "minute": 60, "minutes": 60, "h": 3600, "hr": 3600, "hour": 3600, "hours": 3600,
         "d": 86400, "day": 86400, "days": 86400, "w": 604800, "week": 604800, "weeks": 604800}


def seconds(value):
    """systemd time span: "2min", "6h", "1h 30min", "90" (seconds)."""
    value = (value or "").strip()
    if not value:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", value):
        return float(value)
    total = 0.0
    for number, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([a-z]+)", value):
        total += float(number) * UNITS.get(unit, 0)
    return total


def unit_file(name):
    for directory in UNIT_DIRS:
        path = os.path.join(directory, name)
        if os.path.exists(path):
            return path
    return None


def timer_settings(name):
    path = unit_file(name)
    if not path:
        return None
    settings, section = {}, None
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if line.startswith("["):
                section = line.strip("[]")
            elif section == "Timer" and "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                settings[key.strip()] = value.strip()
    return settings


def pid_file(name):
    return os.path.join(RUN_DIR, name + ".pid")


def running_pid(name):
    try:
        pid = int(open(pid_file(name)).read())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def run_loop(name):
    """The timer itself; runs detached until stopped."""
    settings = timer_settings(name) or {}
    service = settings.get("Unit") or name[: -len(".timer")] + ".service"
    first = seconds(settings.get("OnActiveSec")) or seconds(settings.get("OnBootSec")) or 0
    period = seconds(settings.get("OnUnitActiveSec")) or seconds(settings.get("OnUnitInactiveSec"))
    jitter = seconds(settings.get("RandomizedDelaySec")) or 0
    time.sleep(first + random.uniform(0, jitter))
    while True:
        subprocess.call([sys.executable, REAL, "start", service])
        if not period:
            return
        time.sleep(period + random.uniform(0, jitter))


def start(name):
    if not timer_settings(name):
        print(f"Unit {name} not found.", file=sys.stderr)
        return 5
    if running_pid(name):
        return 0
    os.makedirs(RUN_DIR, exist_ok=True)
    child = subprocess.Popen([sys.executable, os.path.abspath(__file__), "__run-timer", name],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    with open(pid_file(name), "w") as handle:
        handle.write(str(child.pid))
    return 0


def stop(name):
    pid = running_pid(name)
    if pid:
        os.kill(pid, signal.SIGTERM)
    try:
        os.remove(pid_file(name))
    except OSError:
        pass
    return 0


def enable(name):
    path = unit_file(name)
    if not path:
        return 5
    os.makedirs(WANTS, exist_ok=True)
    link = os.path.join(WANTS, name)
    if not os.path.lexists(link):
        os.symlink(path, link)
    return 0


def disable(name):
    link = os.path.join(WANTS, name)
    if os.path.lexists(link):
        os.remove(link)
    return 0


def handle_timers(command, names, now):
    code = 0
    for name in names:
        if command == "start":
            code |= start(name)
        elif command == "restart":
            stop(name)
            code |= start(name)
        elif command == "stop":
            code |= stop(name)
        elif command == "enable":
            code |= enable(name)
            if now:
                code |= start(name)
        elif command == "disable":
            code |= disable(name)
            if now:
                stop(name)
        elif command == "is-active":
            active = running_pid(name) is not None
            print("active" if active else "inactive")
            code |= 0 if active else 3
        elif command == "is-enabled":
            enabled = os.path.lexists(os.path.join(WANTS, name))
            print("enabled" if enabled else "disabled")
            code |= 0 if enabled else 1
        elif command == "status":
            pid = running_pid(name)
            print(f"{name} - {'active (waiting), pid ' + str(pid) if pid else 'inactive (dead)'}")
            code |= 0 if pid else 3
    return code


def main(argv):
    if len(argv) >= 2 and argv[0] == "__run-timer":
        run_loop(argv[1])
        return 0
    if len(argv) >= 1 and argv[0] == "__start-enabled-timers":
        for name in sorted(os.listdir(WANTS)) if os.path.isdir(WANTS) else []:
            if name.endswith(".timer"):
                start(name)
        return 0
    words = [arg for arg in argv if not arg.startswith("-")]
    command = words[0] if words else ""
    timers = [word for word in words[1:] if word.endswith(".timer")]
    others = [word for word in words[1:] if not word.endswith(".timer")]
    if not timers:
        os.execv(sys.executable, [sys.executable, REAL] + argv)
    code = handle_timers(command, timers, "--now" in argv)
    if others:
        flags = [arg for arg in argv if arg.startswith("-")]
        code |= subprocess.call([sys.executable, REAL] + flags + [command] + others)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
