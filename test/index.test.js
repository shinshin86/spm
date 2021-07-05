const { execSync } = require('child_process');
test('Test', () => {
  execSync('node .');

  const tarStream = require('../spm_node_modules/tar-stream');
  const react = require('../spm_node_modules/react');

  expect(tarStream).toBeTruthy();
  expect(react).toBeTruthy();
});
