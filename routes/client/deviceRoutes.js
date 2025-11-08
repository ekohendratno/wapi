const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/Utils.js');
const moment = require('moment-timezone');

module.exports = ({sessionManager, deviceManager, billingManager}) => {

    router.get("/", authMiddleware, async (req, res) => {
        try {
            const apiKey = req.session.user.api_key;
    
            const devices = await deviceManager.getDevices(apiKey);  
            const packages = await billingManager.getPackages();
            const devicesWithLastActive = await deviceManager.getDevicesWithLastActive(apiKey);
            const activeDeviceCount = await deviceManager.getActiveDeviceCount(apiKey);

                        // Build a simple device history from devices (latest updated first)
                        const deviceHistory = (devices || [])
                            .slice()
                            .sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at))
                            .slice(0, 10)
                            .map(d => ({
                                device_key: d.device_key,
                                status: d.status,
                                when: d.updated_at ? moment(d.updated_at).tz('Asia/Jakarta').fromNow() : '-',
                                note: d.name || ''
                            }));

                        res.render("client/device", {
                                countDeviceLast: devicesWithLastActive,
                                countDevice: activeDeviceCount,
                                devices: devices || [],
                                packages: packages || [],
                                apiKey: apiKey,
                                deviceHistory: deviceHistory,
                                title: "Device - w@pi",
                                layout: "layouts/client"
                        });
        } catch (error) {
            console.error('Error:', error);
            res.status(500).send("Internal Server Error");
        }
    });

    
    router.get("/status", authMiddleware, async (req, res) => {
        const {deviceKey} = req.query;
        try {
            const apiKey = req.session.user.api_key;
            const device = await deviceManager.getDevice(apiKey, deviceKey);

            res.render("client/device-status", { device: device|| [], apiKey: apiKey, deviceKey: deviceKey, title: "Device Status", layout: "layouts/client" });
        } catch (error) {
            console.error('Error:', error);
            res.status(500).send("Internal Server Error");
        }
    });

    router.post('/register', authMiddleware, async (req, res) => {
        const { apiKey, deviceName, phoneNumber, packageId } = req.body;
        try {
            const result = await deviceManager.registerDevice(apiKey, deviceName, phoneNumber, packageId);
            res.json({
                status: result.status,
                message: result.message,
                data: result.data
            });
        } catch (error) {
            if (error.message.includes('Saldo tidak mencukupi')) {
                return res.status(400).json({
                    status: false,
                    message: error.message,
                    redirect: '/client/billing'
                });
            }
            res.status(500).json({
                status: false,
                message: error.message
            });
        }
    });

    router.delete('/remove', authMiddleware, async (req, res) => {
        try {
            const { apiKey, deviceKey } = req.query;
            const result = await deviceManager.removeDevice(apiKey, deviceKey);
            res.json({ status: true, message: 'Device deleted successfully' });
        } catch (error) {
            console.error('Delete device error:', error);
            const statusCode = error.output?.statusCode || 500;
            res.status(statusCode).json({
                status: false,
                message: error.message
            });
        }
    });


    router.get("/group", authMiddleware, async (req, res) => {
        const {deviceKey} = req.query;
        try {
            const apiKey = req.session.user.api_key;
            const device = await deviceManager.getDevice(apiKey, deviceKey);
            const groups = await deviceManager.getGroups(apiKey, deviceKey);  

            res.render("client/device-group", { groups: groups|| [], device: device|| [], apiKey: apiKey, deviceKey: deviceKey, title: "Device Group", layout: "layouts/client" });
        } catch (error) {
            console.error('Error:', error);
            res.status(500).send("Internal Server Error");
        }
    });

    return router;
};