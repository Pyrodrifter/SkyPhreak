const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { LcdRepeater } = require('./lcdRepeater.cjs');

test('connects over TCP and forwards a line to the display', async () => {
  const received = [];
  const server = net.createServer((sock) => sock.on('data', (d) => received.push(d.toString('utf8'))));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const lcd = new LcdRepeater();
  const r = await lcd.connect({ transport: 'tcp', host: '127.0.0.1', port });
  assert.equal(r.ok, true);
  assert.equal(lcd.connected, true);

  assert.equal(lcd.send('AZ179.4 EL42.1\n'), true);
  // Let the byte cross the socket.
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(received.join(''), 'AZ179.4 EL42.1\n');

  lcd.close();
  assert.equal(lcd.connected, false);
  assert.equal(lcd.send('ignored\n'), false); // no-op once closed
  await new Promise((res) => server.close(res));
});

test('reports a friendly failure for an unreachable TCP endpoint', async () => {
  const lcd = new LcdRepeater();
  // Port 1 is privileged/closed — connect should fail, not throw.
  const r = await lcd.connect({ transport: 'tcp', host: '127.0.0.1', port: 1 });
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  lcd.close();
});
