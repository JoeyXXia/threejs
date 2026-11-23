// Keep the fixture offsets and let the suite move together off reserved ports.
const base = process.env.TEST_API_PORT_BASE ?? '13000';
if (!/^\d{1,5}$/.test(base) || Number(base) < 1024 || Number(base) > 65535 - 19) {
  throw new Error('Invalid TEST_API_PORT_BASE');
}
module.exports = (offset) => String(Number(base) + offset);
