#!/bin/bash

set -e

SERVICE_FILE="/etc/systemd/system/free-sleep-wifi-provisioning.service"

FREE_SLEEP_DIR="/home/dac/free-sleep"
SERVER_DIR="$FREE_SLEEP_DIR/server"

NODE_PATH="/home/dac/.volta/bin/node"
PROVISIONING_SERVER="$SERVER_DIR/dist/wifiProvisioning/provisioningServer.js"


echo "Setting up Free Sleep Wi-Fi provisioning service..."


#
# Make sure the things the service needs actually exist.
#
if [ ! -x "$NODE_PATH" ]; then
  echo "ERROR: Node was not found at $NODE_PATH"
  exit 1
fi


if [ ! -f "$PROVISIONING_SERVER" ]; then
  echo "ERROR: Wi-Fi provisioning server was not found at:"
  echo "$PROVISIONING_SERVER"
  exit 1
fi


#
# Create the boot service.
#
# We wait for NetworkManager itself to be running, but deliberately do
# not wait for network-online.target.
#
# If there is no working saved Wi-Fi, network-online may never happen,
# which is when this service is needed.
#
echo "Creating systemd service file at $SERVICE_FILE..."

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Free Sleep Wi-Fi Provisioning
Wants=NetworkManager.service
After=NetworkManager.service

[Service]
Type=simple

ExecStart=$NODE_PATH $PROVISIONING_SERVER

WorkingDirectory=$SERVER_DIR

User=root
Group=root

Environment=NODE_ENV=production
Environment=VOLTA_HOME=/home/dac/.volta
Environment=PATH=/home/dac/.volta/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF


#
# Enable it for every boot.
#
# The Node service itself decides whether setup is needed:
#
#   working saved Wi-Fi -> exits
#   no working Wi-Fi    -> starts FreeSleep-Setup
#
echo "Reloading systemd..."

systemctl daemon-reload


echo "Enabling free-sleep-wifi-provisioning.service..."

systemctl enable free-sleep-wifi-provisioning.service


echo "Wi-Fi provisioning service installed."