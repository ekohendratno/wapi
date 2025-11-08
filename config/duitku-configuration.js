// Compatibility shim for packages that require 'config/duitku-configuration'.
// Re-export project's config-duitku.js when available; otherwise fall back to
// environment variables so the package doesn't crash at require-time.

try {
  // config-duitku.js lives at project root
  module.exports = require('../config-duitku');
} catch (err) {
  // Fallback minimal config (use env vars). Replace with real values in config-duitku.js
  module.exports = {
    merchantCode: process.env.DUITKU_MERCHANT_CODE || '',
    merchantKey: process.env.DUITKU_MERCHANT_KEY || '',
    callbackUrl: process.env.DUITKU_CALLBACK_URL || '',
    returnUrl: process.env.DUITKU_RETURN_URL || '',
    environment: process.env.DUITKU_ENVIRONMENT || 'sandbox'
  };
}
