const axios = require('axios');
const crypto = require('crypto');
const config = require('../config-duitku');


async function createDuitkuInvoice(user, amount, paymentMethodCode, productDetail = 'Top-Up Saldo', merchantOrderIdInput) {
    // allow caller to pass merchantOrderId to keep IDs consistent between
    // the saved transaction and the gateway request
    const merchantOrderId = merchantOrderIdInput || `ORDER-${Date.now()}`;
    const transaction = {
        paymentAmount: parseInt(amount),
        paymentMethod: paymentMethodCode,
        merchantOrderId,
        productDetails: productDetail,
        email: user && user.email ? user.email : '',
        phoneNumber: user && user.phone ? user.phone : '',
        additionalParam: user && user.uid ? String(user.uid) : undefined,
        merchantUserInfo: user && user.name ? user.name : undefined,
        customerVaName: user && user.name ? user.name : undefined,
        callbackUrl: config.callbackUrl,
        returnUrl: config.returnUrl,
        expiryPeriod: 1440,
    };

    try {
        // We'll call the Duitku API directly via axios to keep the request
        // mechanics under our control (timestamp/signature). This avoids
        // inconsistencies from third-party client libs.
        const environment = config.environment || 'sandbox';
        const url = `https://api-${environment}.duitku.com/api/merchant/createInvoice`;

    // Per Duitku docs we must send the timestamp in milliseconds in the
    // Jakarta timezone. In practice the sandbox expects epoch-ms shifted
    // to WIB (UTC+7) so compute timestamp accordingly.
    const timestamp = Date.now() + 7 * 3600 * 1000; // Jakarta ms
    const signature = crypto.createHash('sha256').update(`${config.merchantCode}${timestamp}${config.merchantKey}`).digest('hex');

        const headers = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-duitku-signature': signature,
            'x-duitku-timestamp': String(timestamp),
            'x-duitku-merchantcode': config.merchantCode,
        };

        // Debug: log request metadata (merchantCode masked)
        console.log('[DuitKu] createInvoice request:');
        console.log('  url=', url);
        console.log('  merchantCode=', `${String(config.merchantCode).slice(0, 4)}****`);
        console.log('  timestamp=', timestamp, 'iso=', new Date(timestamp).toISOString());
        console.log('  signature=', signature);
        console.log('  transaction=', JSON.stringify({ paymentAmount: transaction.paymentAmount, merchantOrderId: transaction.merchantOrderId, productDetails: transaction.productDetails }));

        const resp = await axios.post(url, transaction, { headers, timeout: 15000 });
        const data = resp && resp.data ? resp.data : {};

        console.log('[DuitKu] createInvoice response status=', resp.status);
        console.log('[DuitKu] createInvoice response data=', JSON.stringify(data));

        const { reference, paymentUrl, statusCode, statusMessage } = data;
        if (statusCode === '00') return { success: true, reference, paymentUrl, merchantOrderId, raw: data };
        throw new Error(statusMessage || 'Failed to create invoice');
    } catch (error) {
        console.error('Error creating Duitku invoice:');
        if (error.response) {
            console.error('  status=', error.response.status);
            console.error('  data=', JSON.stringify(error.response.data));
        } else {
            console.error('  message=', error && error.message);
        }
        throw error;
    }
}

module.exports = { createDuitkuInvoice };