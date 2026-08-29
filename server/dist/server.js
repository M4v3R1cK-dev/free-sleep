import './instrument.js';
import express from 'express';
import schedule from 'node-schedule';
import logger from './logger.js';
import { connectFranken, disconnectFranken } from './8sleep/frankenServer.js';
import { wait } from './8sleep/promises.js';
import { FrankenMonitor } from './8sleep/frankenMonitor.js';
import './jobs/jobScheduler.js';
// Setup code
import setupMiddleware from './setup/middleware.js';
import setupRoutes from './setup/routes.js';
import config from './config.js';
import serverStatus from './serverStatus.js';
import { prisma } from './db/prisma.js';
import { setupSentryTags } from './setupSentryTags.js';
import { loadWifiSignalStrength } from './8sleep/wifiSignalStrength.js';
const port = 3000;
const app = express();
let server;
let frankenMonitor;
async function disconnectPrisma() {
    try {
        logger.debug('Flushing SQLite');
        // Flush WAL into main DB and truncate WAL file
        // (no-op if not in WAL mode)
        await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        logger.debug('Flushed SQLite');
    }
    catch (error) {
        logger.error('Error flushing SQLite');
        const message = error instanceof Error
            ? error.message
            : String(error);
        logger.error(message);
    }
    try {
        logger.debug('Disconnecting Prisma');
        await prisma.$disconnect();
        logger.debug('Disconnected Prisma');
    }
    catch (error) {
        logger.error('Error disconnecting from Prisma');
        const message = error instanceof Error
            ? error.message
            : String(error);
        logger.error(message);
    }
}
// Graceful Shutdown Function
async function gracefulShutdown(signal) {
    logger.debug(`\nReceived ${signal}. Initiating graceful shutdown...`);
    let finishedExiting = false;
    // Force shutdown after 15 seconds
    setTimeout(() => {
        if (finishedExiting) {
            return;
        }
        const error = new Error('Could not close connections in time. Forcing shutdown.');
        logger.error({ error });
        process.exit(1);
    }, 15_000);
    logger.debug('Stopping node-schedule');
    await schedule.gracefulShutdown();
    await disconnectPrisma();
    try {
        if (server) {
            // Stop accepting new connections
            server.close(() => {
                logger.debug('Closed out remaining HTTP connections.');
            });
        }
        if (!config.remoteDevMode) {
            frankenMonitor?.stop();
            await disconnectFranken();
            logger.debug('Successfully closed Franken components.');
        }
    }
    catch (error) {
        logger.error(`Error during shutdown: ${error}`);
    }
    finishedExiting = true;
    logger.debug('Exiting now...');
    process.exit(0);
}
//
// Franken startup
//
// On this Pod, the Unix socket can connect before the underlying
// hardware is actually ready to answer DEVICE_STATUS.
//
// Give the first connection a short settling period, then confirm
// real hardware communication before declaring Franken healthy.
//
// If that first connection is stale, close it and allow the existing
// Franken connection retry logic to create a fresh socket and wait
// for frankenfirmware to reconnect.
//
const FRANKEN_READY_MAX_ATTEMPTS = 8;
const FRANKEN_READY_RETRY_DELAY_MS = 5_000;
const FRANKEN_INITIAL_SETTLE_DELAY_MS = 30_000;
async function initFranken() {
    logger.info('Initializing Franken on startup...');
    serverStatus.status.franken.status = 'started';
    let lastError;
    for (let attempt = 1; attempt <= FRANKEN_READY_MAX_ATTEMPTS; attempt++) {
        try {
            logger.info(`Checking Franken hardware readiness... attempt ${attempt}/${FRANKEN_READY_MAX_ATTEMPTS}`);
            const franken = await connectFranken();
            /*
             * The first socket connection happens very early during boot.
             *
             * Give the Pod hardware a little time before sending the first
             * DEVICE_STATUS request.
             */
            if (attempt === 1) {
                logger.info(`Franken socket connected. Waiting ${FRANKEN_INITIAL_SETTLE_DELAY_MS / 1000}s for hardware startup.`);
                await wait(FRANKEN_INITIAL_SETTLE_DELAY_MS);
            }
            /*
             * Socket connected does not necessarily mean hardware ready.
             *
             * Only declare Franken healthy once a genuine DEVICE_STATUS
             * request succeeds.
             */
            await franken.getDeviceStatus(false);
            serverStatus.status.franken.status = 'healthy';
            serverStatus.status.franken.message = '';
            logger.info('Franken hardware is ready.');
            return;
        }
        catch (error) {
            lastError = error;
            const message = error instanceof Error
                ? error.message
                : String(error);
            logger.warn(`Franken hardware is not ready yet: ${message}`);
            /*
             * Drop the failed/stale Free Sleep side of the connection.
             *
             * connectFranken() will then create a fresh socket server and
             * wait for frankenfirmware to reconnect.
             */
            await disconnectFranken();
            if (attempt <
                FRANKEN_READY_MAX_ATTEMPTS) {
                await wait(FRANKEN_READY_RETRY_DELAY_MS);
            }
        }
    }
    if (lastError instanceof Error) {
        throw lastError;
    }
    throw new Error('Franken hardware did not become ready during startup.');
}
const initFrankenMonitor = () => {
    logger.info('Starting franken monitor...');
    serverStatus.status.frankenMonitor.status = 'started';
    frankenMonitor = new FrankenMonitor();
    void frankenMonitor.start();
    logger.info('Frank monitor started!');
};
// Main startup function
async function startServer() {
    setupMiddleware(app);
    setupRoutes(app);
    // Listen on desired port
    server = app.listen(port, () => {
        logger.debug(`Server running on http://localhost:${port}`);
    });
    serverStatus.status.express.status = 'healthy';
    serverStatus.status.logger.status = 'healthy';
    // Initialize Franken on startup
    if (!config.remoteDevMode) {
        void initFranken()
            .then(() => {
            setupSentryTags();
            initFrankenMonitor();
        })
            .catch((error) => {
            serverStatus.status.franken.status =
                'failed';
            const message = error instanceof Error
                ? error.message
                : String(error);
            serverStatus.status.franken.message =
                message;
            logger.error(error);
        });
    }
    void loadWifiSignalStrength();
    setInterval(loadWifiSignalStrength, 10_000);
    // Register signal handlers for graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught Exception:', error);
        logger.error(error);
        await gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', async (reason, promise) => {
        logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
        await gracefulShutdown('unhandledRejection');
    });
}
// Actually start the server
startServer()
    .catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
});
//# sourceMappingURL=server.js.map