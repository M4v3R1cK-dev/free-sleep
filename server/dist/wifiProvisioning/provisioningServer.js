import express from 'express';
import logger from '../logger.js';
import { SETUP_IP_ADDRESS, SETUP_SSID, connectToWifi, scanWifiNetworks, startSetupHotspot, stopSetupHotspot, waitForNormalWifiConnection, } from './networkManager.js';
const PROVISIONING_PORT = 80;
/*
 * Give normal saved wifi 30 seconds to come back during boot.
 *
 * Only this boot check can start provisioning.
 * Losing wifi later while the pod is running does not start this service.
 */
const NORMAL_WIFI_WAIT_TIME = 30_000;
/*
 * FreeSleep-Setup stays available for ten minutes.
 *
 * A failed connection attempt returns to the same setup window rather
 * than starting another fresh ten minutes.
 */
const PROVISIONING_TIME = 10 * 60 * 1000;
/*
 * Give the browser time to receive our response before wlan0 changes
 * from FreeSleep-Setup to the selected home wifi.
 */
const CONNECTION_START_DELAY = 1000;
let server;
let provisioningTimeout;
let provisioningEndsAt = 0;
let cachedNetworks = [];
let connectionAttemptInProgress = false;
let lastConnectionFailed = false;
let shuttingDown = false;
/*
 * Work out how much of the setup window is left.
 */
function getMillisecondsRemaining() {
    const remaining = provisioningEndsAt - Date.now();
    if (remaining < 0) {
        return 0;
    }
    return remaining;
}
/*
 * The setup page only needs whole seconds for its countdown.
 */
function getSecondsRemaining() {
    return Math.ceil(getMillisecondsRemaining() / 1000);
}
/*
 * Everything for the setup page lives locally on the pod.
 *
 * No outside CSS, JavaScript, fonts or internet connection are needed.
 */
function getSetupPage() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>Free Sleep Wi-Fi Setup</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 20px;
      font-family: Arial, sans-serif;
      background: #111111;
      color: #eeeeee;
    }

    .page {
      width: 100%;
      max-width: 520px;
      margin: 30px auto;
    }

    .card {
      background: #1d1d1d;
      border: 1px solid #333333;
      border-radius: 14px;
      padding: 24px;
    }

    h1 {
      margin-top: 0;
      margin-bottom: 10px;
      font-size: 26px;
    }

    .description {
      color: #bbbbbb;
      line-height: 1.5;
      margin-bottom: 22px;
    }

    label {
      display: block;
      margin-top: 18px;
      margin-bottom: 7px;
      font-weight: bold;
    }

    select,
    input[type="text"],
    input[type="password"] {
      width: 100%;
      padding: 12px;
      border: 1px solid #555555;
      border-radius: 8px;
      background: #111111;
      color: #ffffff;
      font-size: 16px;
    }

    button {
      width: 100%;
      margin-top: 24px;
      padding: 13px;
      border: 0;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
    }

    .checkbox-row label {
      margin: 0;
      font-weight: normal;
    }

    #manual-network {
      display: none;
    }

    #message {
      min-height: 48px;
      margin-top: 20px;
      padding: 12px;
      border-radius: 8px;
      background: #252525;
      line-height: 1.4;
    }

    #time-left {
      margin-top: 18px;
      color: #aaaaaa;
      font-size: 14px;
    }

    .small {
      margin-top: 20px;
      color: #999999;
      font-size: 13px;
      line-height: 1.4;
    }
  </style>
</head>

<body>

  <div class="page">

    <div class="card">

      <h1>Free Sleep Wi-Fi Setup</h1>

      <div class="description">
        Connect this Pod to your home Wi-Fi.
      </div>

      <form id="wifi-form">

        <div id="normal-network">

          <label for="wifi-network">
            Wi-Fi network
          </label>

          <select id="wifi-network">
            <option value="">
              Loading networks...
            </option>
          </select>

        </div>


        <div class="checkbox-row">

          <input
            id="hidden-network"
            type="checkbox"
          >

          <label for="hidden-network">
            My Wi-Fi is hidden
          </label>

        </div>


        <div id="manual-network">

          <label for="manual-ssid">
            Wi-Fi name
          </label>

          <input
            id="manual-ssid"
            type="text"
            autocomplete="off"
          >

        </div>


        <label for="wifi-password">
          Wi-Fi password
        </label>

        <input
          id="wifi-password"
          type="password"
          autocomplete="current-password"
        >


        <div class="checkbox-row">

          <input
            id="show-password"
            type="checkbox"
          >

          <label for="show-password">
            Show password
          </label>

        </div>


        <button
          id="connect-button"
          type="submit"
        >
          Connect
        </button>

      </form>


      <div id="message">
        Choose your Wi-Fi network and enter its password.
      </div>


      <div id="time-left">
      </div>


      <div class="small">
        When Connect is pressed, ${SETUP_SSID} will disappear while the
        Pod tries your Wi-Fi. If it fails, ${SETUP_SSID} will return and
        you can reconnect to it and try again.
      </div>

    </div>

  </div>


  <script>
    var wifiForm = document.getElementById('wifi-form');
    var wifiNetwork = document.getElementById('wifi-network');
    var wifiPassword = document.getElementById('wifi-password');

    var hiddenNetwork = document.getElementById('hidden-network');
    var manualNetwork = document.getElementById('manual-network');
    var manualSsid = document.getElementById('manual-ssid');

    var showPassword = document.getElementById('show-password');

    var connectButton = document.getElementById('connect-button');
    var message = document.getElementById('message');
    var timeLeft = document.getElementById('time-left');


    function showMessage(text) {
      message.textContent = text;
    }


    function updateTimeLeft(secondsRemaining) {

      if (secondsRemaining <= 0) {
        timeLeft.textContent = 'Setup time has expired.';
        return;
      }

      var minutes = Math.floor(secondsRemaining / 60);
      var seconds = secondsRemaining % 60;

      var paddedSeconds = String(seconds).padStart(2, '0');

      timeLeft.textContent =
        'Setup available for ' +
        minutes +
        ':' +
        paddedSeconds;
    }


    async function loadNetworks() {

      try {

        var response = await fetch(
          '/api/networks',
          {
            cache: 'no-store',
          }
        );

        if (!response.ok) {
          throw new Error('Could not load Wi-Fi networks');
        }

        var result = await response.json();

        wifiNetwork.innerHTML = '';

        if (result.networks.length === 0) {

          var emptyOption = document.createElement('option');

          emptyOption.value = '';
          emptyOption.textContent = 'No networks found';

          wifiNetwork.appendChild(emptyOption);

          return;
        }

        for (var network of result.networks) {

          var option = document.createElement('option');

          option.value = network.ssid;

          option.textContent =
            network.ssid +
            ' - ' +
            network.signal +
            '%';

          wifiNetwork.appendChild(option);
        }

      } catch {

        wifiNetwork.innerHTML = '';

        var failedOption = document.createElement('option');

        failedOption.value = '';
        failedOption.textContent = 'Could not load networks';

        wifiNetwork.appendChild(failedOption);

        showMessage(
          'Could not load the Wi-Fi list. You can still use the hidden network option.'
        );
      }
    }


    async function loadStatus() {

      try {

        var response = await fetch(
          '/api/status',
          {
            cache: 'no-store',
          }
        );

        if (!response.ok) {
          return;
        }

        var result = await response.json();

        updateTimeLeft(result.secondsRemaining);

        if (result.lastConnectionFailed) {

          showMessage(
            'The last Wi-Fi connection failed. Check the password and try again.'
          );
        }

      } catch {
        // The setup network may be changing, so there is nothing to do here.
      }
    }


    hiddenNetwork.addEventListener(
      'change',
      function () {

        if (hiddenNetwork.checked) {
          manualNetwork.style.display = 'block';
        } else {
          manualNetwork.style.display = 'none';
        }
      }
    );


    showPassword.addEventListener(
      'change',
      function () {

        if (showPassword.checked) {
          wifiPassword.type = 'text';
        } else {
          wifiPassword.type = 'password';
        }
      }
    );


    wifiForm.addEventListener(
      'submit',
      async function (event) {

        event.preventDefault();

        var ssid = '';

        if (hiddenNetwork.checked) {
          ssid = manualSsid.value.trim();
        } else {
          ssid = wifiNetwork.value;
        }

        if (ssid === '') {
          showMessage('Choose or enter a Wi-Fi network first.');
          return;
        }

        connectButton.disabled = true;

        showMessage(
          'Sending Wi-Fi details to the Pod...'
        );

        try {

          var response = await fetch(
            '/api/connect',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ssid: ssid,
                password: wifiPassword.value,
                hiddenNetwork: hiddenNetwork.checked,
              }),
            }
          );

          if (!response.ok) {

            var errorResult = await response.json();

            if (errorResult.error) {
              throw new Error(errorResult.error);
            }

            throw new Error('The Pod could not start the connection attempt');
          }

          showMessage(
            'The Pod is trying to connect to ' +
            ssid +
            '. ' +
            '${SETUP_SSID} will disappear now. ' +
            'If the connection fails, reconnect to ${SETUP_SSID} and try again.'
          );

        } catch (error) {

          connectButton.disabled = false;

          if (error instanceof Error) {
            showMessage(error.message);
            return;
          }

          showMessage('Could not send the Wi-Fi details.');
        }
      }
    );


    loadNetworks();
    loadStatus();

    setInterval(
      loadStatus,
      5000
    );
  </script>

</body>
</html>
`;
}
/*
 * Close the little setup web server if it is running.
 */
function closeHttpServer() {
    return new Promise((resolve) => {
        if (!server) {
            resolve();
            return;
        }
        server.close(() => {
            server = undefined;
            resolve();
        });
    });
}
/*
 * Finish setup and clean up anything belonging to provisioning.
 *
 * This is used for success, timeout, shutdown and fatal errors.
 */
async function stopProvisioning(exitCode) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    if (provisioningTimeout) {
        clearTimeout(provisioningTimeout);
        provisioningTimeout = undefined;
    }
    await stopSetupHotspot();
    await closeHttpServer();
    process.exit(exitCode);
}
/*
 * Try the Wi-Fi details submitted by the setup page.
 *
 * The HTTP response has already gone back to the phone before this runs,
 * because changing wlan0 will disconnect the phone from FreeSleep-Setup.
 */
async function runConnectionAttempt(ssid, password, hiddenNetwork) {
    connectionAttemptInProgress = true;
    lastConnectionFailed = false;
    logger.info(`Trying provisioned Wi-Fi network: ${ssid}`);
    const connected = await connectToWifi(ssid, password, hiddenNetwork);
    connectionAttemptInProgress = false;
    if (connected) {
        logger.info('Wi-Fi provisioning completed successfully.');
        await stopProvisioning(0);
        return;
    }
    lastConnectionFailed = true;
    logger.warn(`Could not connect to provisioned Wi-Fi network: ${ssid}`);
    /*
     * Do not start another hotspot if the original ten minute setup
     * window has already ended.
     */
    if (getMillisecondsRemaining() === 0) {
        await stopProvisioning(0);
        return;
    }
    try {
        await startSetupHotspot();
        logger.info(`${SETUP_SSID} restarted after failed Wi-Fi connection.`);
    }
    catch (error) {
        const message = error instanceof Error
            ? error.message
            : String(error);
        logger.error(`Could not restart setup hotspot: ${message}`);
        await stopProvisioning(1);
    }
}
/*
 * Add the routes used by the setup page.
 */
function setupRoutes(app) {
    app.use(express.json({
        limit: '8kb',
    }));
    app.get('/api/networks', (_request, response) => {
        response.json({
            networks: cachedNetworks,
        });
    });
    app.get('/api/status', (_request, response) => {
        response.json({
            connecting: connectionAttemptInProgress,
            lastConnectionFailed: lastConnectionFailed,
            secondsRemaining: getSecondsRemaining(),
        });
    });
    app.post('/api/connect', (request, response) => {
        if (getMillisecondsRemaining() === 0) {
            response.status(410).json({
                error: 'The Wi-Fi setup window has expired.',
            });
            return;
        }
        if (connectionAttemptInProgress) {
            response.status(409).json({
                error: 'The Pod is already trying a Wi-Fi connection.',
            });
            return;
        }
        const requestBody = request.body;
        let ssid = '';
        if (typeof requestBody.ssid === 'string') {
            ssid = requestBody.ssid.trim();
        }
        let password = '';
        if (typeof requestBody.password === 'string') {
            password = requestBody.password;
        }
        const hiddenNetwork = requestBody.hiddenNetwork === true;
        if (ssid === '') {
            response.status(400).json({
                error: 'A Wi-Fi network name is required.',
            });
            return;
        }
        /*
         * These are only sanity limits to stop a broken or malicious request
         * dumping a huge amount of text into nmcli.
         */
        if (ssid.length > 128) {
            response.status(400).json({
                error: 'The Wi-Fi network name is too long.',
            });
            return;
        }
        if (password.length > 512) {
            response.status(400).json({
                error: 'The Wi-Fi password is too long.',
            });
            return;
        }
        /*
         * Reply before changing wlan0.
         *
         * If we stopped the hotspot first the phone would disappear before
         * its browser knew that the request had been accepted.
         */
        response.status(202).json({
            accepted: true,
        });
        setTimeout(() => {
            void runConnectionAttempt(ssid, password, hiddenNetwork);
        }, CONNECTION_START_DELAY);
    });
    /*
     * Anything else that reaches port 80 gets the setup page.
     *
     * This also means common captive portal probe URLs will at least get
     * the page if their request reaches the Pod.
     */
    app.get('/{*splat}', (_request, response) => {
        response
            .status(200)
            .type('html')
            .send(getSetupPage());
    });
}
/*
 * Start the web server after the hotspot already owns 192.168.4.1.
 */
function startHttpServer() {
    return new Promise((resolve, reject) => {
        const app = express();
        setupRoutes(app);
        server = app.listen(PROVISIONING_PORT, SETUP_IP_ADDRESS, () => {
            logger.info(`Wi-Fi setup page running at http://${SETUP_IP_ADDRESS}`);
            resolve();
        });
        server.once('error', (error) => {
            reject(error);
        });
    });
}
/*
 * Ten minutes is up.
 *
 * If nmcli happens to be in the middle of a connection attempt, let that
 * attempt finish first rather than killing it halfway through.
 */
async function provisioningExpired() {
    if (connectionAttemptInProgress) {
        provisioningTimeout = setTimeout(() => {
            void provisioningExpired();
        }, 1000);
        return;
    }
    logger.info('Wi-Fi provisioning window expired.');
    await stopProvisioning(0);
}
/*
 * The Pod could not find a working saved Wi-Fi during boot.
 *
 * Scan while wlan0 is still in client mode, then turn it into the setup
 * access point and start the local setup page.
 */
async function startProvisioningMode() {
    logger.info('No usable saved Wi-Fi connection found.');
    try {
        cachedNetworks = await scanWifiNetworks();
        logger.info(`Found ${cachedNetworks.length} Wi-Fi networks before starting setup mode.`);
    }
    catch (error) {
        cachedNetworks = [];
        const message = error instanceof Error
            ? error.message
            : String(error);
        logger.warn(`Could not scan Wi-Fi networks: ${message}`);
    }
    await startSetupHotspot();
    provisioningEndsAt =
        Date.now() +
            PROVISIONING_TIME;
    await startHttpServer();
    provisioningTimeout = setTimeout(() => {
        void provisioningExpired();
    }, PROVISIONING_TIME);
    logger.info(`${SETUP_SSID} is available for ten minutes.`);
}
/*
 * Clean the hotspot up if systemd stops this service or the Pod shuts down.
 */
async function gracefulShutdown(signal) {
    logger.info(`Wi-Fi provisioning received ${signal}.`);
    await stopProvisioning(0);
}
/*
 * This runs once at boot.
 *
 * It is important that this is not a permanent network monitor.
 * Once the service finishes, a later Wi-Fi drop does not start an AP.
 */
async function startProvisioningService() {
    logger.info('Checking saved Wi-Fi during boot.');
    const normalWifiConnected = await waitForNormalWifiConnection(NORMAL_WIFI_WAIT_TIME);
    if (normalWifiConnected) {
        logger.info('Saved Wi-Fi connected. Provisioning is not needed.');
        return;
    }
    process.on('SIGTERM', () => {
        void gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
        void gracefulShutdown('SIGINT');
    });
    await startProvisioningMode();
}
/*
 * Start the boot-time provisioning check.
 */
startProvisioningService()
    .catch(async (error) => {
    const message = error instanceof Error
        ? error.message
        : String(error);
    logger.error(`Wi-Fi provisioning failed: ${message}`);
    await stopProvisioning(1);
});
//# sourceMappingURL=provisioningServer.js.map