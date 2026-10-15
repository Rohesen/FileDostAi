#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server. Run it once after the first login:
#     sudo bash deploy/server-setup.sh
# It installs Docker, turns on automatic security updates, adds swap space,
# and blocks containers from the cloud's private metadata address.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo:  sudo bash deploy/server-setup.sh"
  exit 1
fi

echo "==> Updating the system"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y git curl unattended-upgrades iptables-persistent

echo "==> Turning on automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Let the normal login user run docker without sudo (takes effect after logging in again).
LOGIN_USER="${SUDO_USER:-}"
if [ -n "$LOGIN_USER" ] && [ "$LOGIN_USER" != "root" ]; then
  usermod -aG docker "$LOGIN_USER"
fi

# 4 GB of swap stops a big conversion from crashing a small server.
if ! swapon --show | grep -q '/swapfile'; then
  echo "==> Adding 4 GB of swap"
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Containers must never read the cloud's metadata service (it can hand out machine credentials).
echo "==> Blocking containers from the cloud metadata address"
if ! iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null; then
  iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
fi
netfilter-persistent save

echo
echo "Done. Log out and log back in once (so docker works without sudo),"
echo "then run:  bash deploy/deploy.sh"
