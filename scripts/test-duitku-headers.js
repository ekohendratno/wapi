const axios = require('axios');
const crypto = require('crypto');
const config = require('../config-duitku');

async function tryRequest(timestamp) {
  const signature = crypto.createHash('sha256').update(`${config.merchantCode}${timestamp}${config.merchantKey}`).digest('hex');
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-duitku-signature': signature,
    'x-duitku-timestamp': String(timestamp),
    'x-duitku-merchantcode': config.merchantCode,
  };
  const url = `https://api-${(config.environment||'sandbox')}.duitku.com/api/merchant/createInvoice`;
  const body = {
    paymentAmount: 25000,
    merchantOrderId: 'TEST-' + timestamp,
    productDetails: 'Top-Up Saldo',
    callbackUrl: config.callbackUrl,
    returnUrl: config.returnUrl,
    expiryPeriod: 10
  };

  try {
    console.log('\n== Request with timestamp:', timestamp, ' iso=', new Date(timestamp).toISOString());
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    console.log('Status:', resp.status, 'Data:', resp.data);
  } catch (err) {
    if (err.response) {
      console.error('Error status=', err.response.status, 'data=', err.response.data);
    } else {
      console.error('Request error', err.message);
    }
  }
}

(async () => {
  const now = Date.now();
  await tryRequest(now);
  const jakarta = now + 7 * 3600 * 1000;
  await tryRequest(jakarta);
})();