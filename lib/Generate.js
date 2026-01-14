const crypto = require('crypto');

const generateRandomString = (length) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
};


module.exports = {
  generateAPIKey: () => crypto.randomBytes(32).toString('hex'),
  generateDeviceID: () => crypto.randomBytes(12).toString('hex'),
  generateGroupID: () => generateRandomString(6),
};