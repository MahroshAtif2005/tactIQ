const { getStorageMode } = require('../shared/store');

module.exports = async function health(context, _req) {
  context.res = {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      ok: true,
      service: 'tactiq-api',
      storage: getStorageMode(),
      timestamp: new Date().toISOString(),
    },
  };
};
