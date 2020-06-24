const { execSync } = require('child_process');
test('Test', () => {
  execSync('node index.js');

  const tarStream = require('./node_modules/tar-stream');

  expect(tarStream).toBeTruthy();
});
