const { execSync } = require('child_process');
test('Test', () => {
  execSync('node .');

  const tarStream = require('../node_modules/tar-stream');

  expect(tarStream).toBeTruthy();
});
