import { execFile } from 'child_process';
export const WIFI_INTERFACE = 'wlan0';
export const SETUP_CONNECTION_NAME = 'FreeSleep-Setup';
export const SETUP_SSID = 'FreeSleep-Setup';
export const SETUP_IP_ADDRESS = '192.168.4.1';
export const SETUP_ADDRESS = '192.168.4.1/24';
export const WIFI_CONNECTION_NAME = 'FreeSleep-WiFi';
/*
 * Run one nmcli command and give the output back as text.
 *
 * execFile is used instead of exec because later the wifi name
 * and password come from the setup page. Each value stays as its
 * own argument and does not get put through a shell.
 */
function runNmcli(argumentsToPass, timeout = 15000) {
    return new Promise((resolve, reject) => {
        execFile('nmcli', argumentsToPass, {
            timeout: timeout,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                /*
                 * Don't pass the original execFile error back because it can
                 * include command details. Later one of these commands contains
                 * the wifi password, so keep that out of anything we may log.
                 */
                if (stderr && stderr.trim() !== '') {
                    reject(new Error(stderr.trim()));
                    return;
                }
                reject(new Error('nmcli command failed'));
                return;
            }
            if (stderr && stderr.trim() !== '') {
                reject(new Error(stderr.trim()));
                return;
            }
            resolve(stdout.trim());
        });
    });
}
/*
 * Same as runNmcli but for cleanup commands where a failure is fine.
 *
 * If we try to remove a connection that already does not exist then
 * there is nothing else we need to do.
 */
async function tryRunNmcli(argumentsToPass, timeout = 15000) {
    try {
        await runNmcli(argumentsToPass, timeout);
    }
    catch {
        // nothing to do here
    }
}
/*
 * Small wait helper so the timing code stays easy to read.
 */
function wait(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
/*
 * Split one line from nmcli terse output.
 *
 * nmcli uses : between fields but escapes a real : or \ inside a value.
 * A plain line.split(':') would therefore break a wifi name such as
 * Home:Wifi.
 */
function splitNmcliLine(line) {
    const parts = [];
    let currentPart = '';
    let escapedCharacter = false;
    for (const character of line) {
        if (escapedCharacter) {
            currentPart += character;
            escapedCharacter = false;
            continue;
        }
        if (character === '\\') {
            escapedCharacter = true;
            continue;
        }
        if (character === ':') {
            parts.push(currentPart);
            currentPart = '';
            continue;
        }
        currentPart += character;
    }
    if (escapedCharacter) {
        currentPart += '\\';
    }
    parts.push(currentPart);
    return parts;
}
/*
 * Get the NetworkManager connection currently using wlan0.
 *
 * Normally this is the person's home wifi. During setup it will be
 * FreeSleep-Setup instead.
 */
export async function getActiveWifiConnectionName() {
    const connectionName = await runNmcli([
        '-g',
        'GENERAL.CONNECTION',
        'device',
        'show',
        WIFI_INTERFACE,
    ]);
    if (connectionName === '') {
        return null;
    }
    if (connectionName === '--') {
        return null;
    }
    return connectionName;
}
/*
 * Check that wlan0 actually has an IPv4 address.
 *
 * A connection name can appear while NetworkManager is still bringing
 * the connection up, so this gives us a second check before calling it
 * properly connected.
 */
export async function hasWifiIpv4Address() {
    const addressResult = await runNmcli([
        '-g',
        'IP4.ADDRESS',
        'device',
        'show',
        WIFI_INTERFACE,
    ]);
    if (addressResult === '') {
        return false;
    }
    if (addressResult === '--') {
        return false;
    }
    return true;
}
/*
 * Check if the pod already has a normal wifi connection.
 *
 * FreeSleep-Setup does not count because that is our hotspot, not the
 * person's actual wifi.
 */
export async function isNormalWifiConnected() {
    const connectionName = await getActiveWifiConnectionName();
    if (connectionName === null) {
        return false;
    }
    if (connectionName === SETUP_CONNECTION_NAME) {
        return false;
    }
    return true;
}
/*
 * Wait for one exact NetworkManager connection to be fully online.
 *
 * This is mainly used after the user has entered new wifi details. It
 * stops some other saved connection from being mistaken for success.
 */
async function waitForWifiConnectionName(connectionName, timeout = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        try {
            const activeConnectionName = await getActiveWifiConnectionName();
            if (activeConnectionName === connectionName) {
                const hasIpAddress = await hasWifiIpv4Address();
                if (hasIpAddress) {
                    return true;
                }
            }
        }
        catch {
            // NetworkManager may still be changing state, so keep waiting
        }
        await wait(1000);
    }
    return false;
}
/*
 * Give NetworkManager time to reconnect saved wifi during boot.
 *
 * The boot provisioning service can call this once. If normal wifi comes
 * back in time we do nothing. If it does not, setup mode can start.
 */
export async function waitForNormalWifiConnection(timeout = 45000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        try {
            const normalWifiConnected = await isNormalWifiConnected();
            if (normalWifiConnected) {
                const hasIpAddress = await hasWifiIpv4Address();
                if (hasIpAddress) {
                    return true;
                }
            }
        }
        catch {
            // NetworkManager may still be starting, so keep waiting
        }
        await wait(1000);
    }
    return false;
}
/*
 * Scan for wifi networks near the pod.
 *
 * We scan before starting the setup hotspot because wlan0 is the same
 * radio used for both jobs. The provisioning service can then keep this
 * list while FreeSleep-Setup is running.
 */
export async function scanWifiNetworks() {
    /*
     * Ask for a fresh scan. If NetworkManager refuses the rescan for a
     * moment, still carry on and use whatever scan results it already has.
     */
    await tryRunNmcli([
        'device',
        'wifi',
        'rescan',
        'ifname',
        WIFI_INTERFACE,
    ]);
    await wait(2000);
    const scanResult = await runNmcli([
        '-t',
        '-f',
        'SSID,SIGNAL,SECURITY',
        'device',
        'wifi',
        'list',
        'ifname',
        WIFI_INTERFACE,
    ]);
    const networks = [];
    const lines = scanResult.split('\n');
    for (const line of lines) {
        if (line.trim() === '') {
            continue;
        }
        const parts = splitNmcliLine(line);
        if (parts.length < 3) {
            continue;
        }
        const ssid = parts[0];
        const signalText = parts[1];
        const security = parts.slice(2).join(':');
        if (!ssid) {
            // hidden networks can be entered manually on the setup page
            continue;
        }
        let signal = Number(signalText);
        if (Number.isNaN(signal)) {
            signal = 0;
        }
        const network = {
            ssid: ssid,
            signal: signal,
            security: security,
        };
        /*
         * Several access points can advertise the same wifi name. Only show
         * the name once and keep the strongest version of it.
         */
        const existingNetwork = networks.find((item) => {
            return item.ssid === network.ssid;
        });
        if (existingNetwork) {
            if (network.signal > existingNetwork.signal) {
                existingNetwork.signal = network.signal;
                existingNetwork.security = network.security;
            }
            continue;
        }
        networks.push(network);
    }
    networks.sort((firstNetwork, secondNetwork) => {
        return secondNetwork.signal - firstNetwork.signal;
    });
    return networks;
}
/*
 * Stop and remove the temporary setup hotspot.
 *
 * Both commands are allowed to fail because the hotspot may already be
 * stopped or may not exist yet.
 */
export async function stopSetupHotspot() {
    await tryRunNmcli([
        'connection',
        'down',
        SETUP_CONNECTION_NAME,
    ]);
    await tryRunNmcli([
        'connection',
        'delete',
        SETUP_CONNECTION_NAME,
    ]);
}
/*
 * Start the temporary FreeSleep-Setup wifi.
 *
 * It is deliberately open and autoconnect is disabled. It only exists
 * when the provisioning service starts it during the boot setup window.
 */
export async function startSetupHotspot() {
    // remove an old setup profile first just in case one was left behind
    await stopSetupHotspot();
    try {
        await runNmcli([
            'connection',
            'add',
            'type',
            'wifi',
            'ifname',
            WIFI_INTERFACE,
            'con-name',
            SETUP_CONNECTION_NAME,
            'autoconnect',
            'no',
            'ssid',
            SETUP_SSID,
        ]);
        /*
         * Shared mode lets NetworkManager handle DHCP and DNS for the phone.
         * We already proved this on the real pod and got a 192.168.4.x address.
         */
        await runNmcli([
            'connection',
            'modify',
            SETUP_CONNECTION_NAME,
            '802-11-wireless.mode',
            'ap',
            'ipv4.method',
            'shared',
            'ipv4.addresses',
            SETUP_ADDRESS,
            'ipv6.method',
            'disabled',
        ]);
        await runNmcli([
            'connection',
            'up',
            SETUP_CONNECTION_NAME,
        ]);
    }
    catch (error) {
        // don't leave half a hotspot profile behind if setup failed
        await stopSetupHotspot();
        throw error;
    }
}
/*
 * Try to connect the pod to the wifi selected on the setup page.
 *
 * The password is only passed straight to nmcli. We do not print it,
 * save it ourselves or include it in any error message.
 */
export async function connectToWifi(ssid, password, hiddenNetwork = false) {
    if (ssid === '') {
        return false;
    }
    /*
     * wlan0 cannot be our hotspot and join the home wifi at the same time.
     * The phone dropping off FreeSleep-Setup here is expected.
     */
    await stopSetupHotspot();
    /*
     * Use a new temporary connection name while testing the new details.
     *
     * We do not delete the old working FreeSleep-WiFi profile first. If the
     * user types a bad password, the old saved wifi is still there for the
     * next boot instead of us throwing good credentials away.
     */
    const candidateConnectionName = WIFI_CONNECTION_NAME + '-New-' + Date.now();
    const connectionArguments = [
        '--wait',
        '30',
        'device',
        'wifi',
        'connect',
        ssid,
        'ifname',
        WIFI_INTERFACE,
        'name',
        candidateConnectionName,
    ];
    /*
     * Empty password means try it as an open network.
     */
    if (password !== '') {
        connectionArguments.push('password', password);
    }
    /*
     * Hidden wifi will be entered manually because it will not appear in
     * the scan list.
     */
    if (hiddenNetwork) {
        connectionArguments.push('hidden', 'yes');
    }
    try {
        await runNmcli(connectionArguments, 35000);
    }
    catch {
        await tryRunNmcli([
            'connection',
            'delete',
            candidateConnectionName,
        ]);
        return false;
    }
    const connected = await waitForWifiConnectionName(candidateConnectionName, 15000);
    if (!connected) {
        await tryRunNmcli([
            'connection',
            'delete',
            candidateConnectionName,
        ]);
        return false;
    }
    /*
     * The new wifi is now proven to work. Make it the preferred saved
     * connection for future boots. device wifi connect normally enables
     * autoconnect anyway, but set it here so our intention is clear.
     */
    await tryRunNmcli([
        'connection',
        'modify',
        candidateConnectionName,
        'connection.autoconnect',
        'yes',
        'connection.autoconnect-priority',
        '100',
    ]);
    /*
     * Only now is it safe to remove the old Free Sleep managed profile.
     * The new connection is already active and has an IP address.
     */
    await tryRunNmcli([
        'connection',
        'delete',
        WIFI_CONNECTION_NAME,
    ]);
    /*
     * Give the successful profile the normal permanent name. If the rename
     * ever fails, do not destroy the candidate profile. It is already a
     * working saved connection and is better left alone than losing wifi.
     */
    try {
        await runNmcli([
            'connection',
            'modify',
            candidateConnectionName,
            'connection.id',
            WIFI_CONNECTION_NAME,
        ]);
    }
    catch {
        // wifi is already working, so leave the saved candidate profile alone
    }
    return true;
}
//# sourceMappingURL=networkManager.js.map