const { createDuitkuInvoice } = require('../lib/DuitKu');
(async () => {
  try {
    const res = await createDuitkuInvoice({name:'Test User', email:'test@example.com', phone:'081234'}, 25000, 'VC', 'Top-Up Saldo', 'TEST-ORDER-' + Date.now());
    console.log('RESULT', JSON.stringify(res, null, 2));
  } catch (e) {
    if (e && e.response) {
      console.error('ERROR RESPONSE', JSON.stringify(e.response.data, null, 2));
    } else {
      console.error('ERROR', e && e.message ? e.message : e);
    }
  }
})();