import { Extract, Pack, Headers as TarFsHeaders } from 'tar-fs';
import { Headers as TarStreamHeaders, Callback } from 'tar-stream';
import { Response } from 'node-fetch';
import { Gunzip } from 'zlib';

export {};
const fetch = require('node-fetch');
const semver = require('semver');
const fs = require('fs-extra');
const cp = require('child_process');
const util = require('util');
const gunzipMaybe = require('gunzip-maybe');
const Progress = require('progress');
const tarFs = require('tar-fs');
const tar = require('tar-stream');
const path = require('path');

const exec = util.promisify(cp.exec);

interface PackageTree {
  name: string;
  reference: string;
  dependencies: Array<PackageTree>;
}

function getFileName(entryName: string, virtualPath: number): string {
  for (let t: number = 0; t < virtualPath; ++t) {
    const index: number = entryName.indexOf('/');

    if (index === -1) {
      return '';
    }

    entryName = entryName.substr(index + 1);
  }

  return entryName;
}

async function readFileFromArchive(
  fileName: string,
  buffer: Buffer,
  { virtualPath = 0 }: Partial<{ virtualPath: number }> = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const extractor: Extract = tar.extract();

    extractor.on(
      'entry',
      (header: TarStreamHeaders, stream: Pack, next: Callback): void => {
        if (getFileName(header.name, virtualPath) === fileName) {
          const buffers: Array<Buffer> = [];

          stream.on('data', (data: Buffer) => {
            buffers.push(data);
          });

          stream.on('error', (error: Buffer) => {
            reject(error);
          });

          stream.on('end', () => {
            resolve(Buffer.concat(buffers));
          });
        } else {
          stream.on('end', () => {
            next();
          });
        }

        stream.resume();
      }
    );

    extractor.on('error', (error: Buffer) => {
      reject(error);
    });

    extractor.on('finish', (): void => {
      reject(new Error(`Couldn't find "${fileName}" inside the archive`));
    });

    const gunzipper: Gunzip = gunzipMaybe();
    gunzipper.pipe(extractor);

    gunzipper.on('error', (error: string) => {
      reject(error);
    });

    gunzipper.write(buffer);
    gunzipper.end();
  });
}

async function readPackageJsonFromArchive(
  packageBuffer: Buffer
): Promise<Buffer> {
  return await readFileFromArchive('package.json', packageBuffer, {
    virtualPath: 1,
  });
}

async function extractArchiveTo(
  packageBuffer: Buffer,
  target: string,
  { virtualPath = 0 }: Partial<{ virtualPath: number }> = {}
) {
  return new Promise((resolve, reject) => {
    function map(header: TarFsHeaders): TarFsHeaders {
      header.name = getFileName(header.name, virtualPath);
      return header;
    }

    const gunzipper = gunzipMaybe();

    const extractor: Extract = tarFs.extract(target, { map });
    gunzipper.pipe(extractor);

    extractor.on('error', (error: Buffer) => {
      reject(error);
    });

    extractor.on('finish', (): void => {
      resolve();
    });

    gunzipper.write(packageBuffer);
    gunzipper.end();
  });
}

async function extractNpmArchiveTo(packageBuffer: Buffer, target: string) {
  return await extractArchiveTo(packageBuffer, target, { virtualPath: 1 });
}

async function trackProgress(cb: Function): Promise<PackageTree> {
  const pace: ProgressBar = new Progress(
    ':bar :current/:total :percent (:elapseds)',
    {
      width: 80,
      total: 1,
    }
  );

  try {
    return await cb(pace);
  } finally {
    if (!pace.complete) {
      pace.update(1);
      pace.terminate();
    }
  }
}

async function linkPackages(
  pace: ProgressBar,
  { name, reference, dependencies }: PackageTree,
  cwd: string
): Promise<void> {
  pace.total += 1;

  await getPackageDependencyTree(pace, {
    name,
    reference,
    dependencies,
  });

  // is not root
  if (reference) {
    const packageBuffer: Buffer = await fetchPackage({ name, reference });
    await extractNpmArchiveTo(packageBuffer, cwd);
  }

  await Promise.all(
    dependencies.map(
      async ({ name, reference, dependencies }: PackageTree): Promise<void> => {
        const target = `${cwd}/spm_node_modules/${name}`;
        const binTarget = `${cwd}/spm_node_modules/.bin`;

        await linkPackages(pace, { name, reference, dependencies }, target);

        const dependencyPackageJson: any = require(`${target}/package.json`);

        const bin: any = dependencyPackageJson.bin || {};
        for (const binName of Object.keys(bin)) {
          const source = path.resolve(target, bin[binName]);
          const dest = `${binTarget}/${binName}`;

          console.log(`bin: ${dest}`);

          await fs.mkdirp(`${cwd}/spm_node_modules/.bin`);
          await fs.symlink(path.relative(binTarget, source), dest);
        }

        if (dependencyPackageJson.scripts) {
          for (const scriptName of ['preinstall', 'install', 'postinstall']) {
            const script: string = dependencyPackageJson.scripts[scriptName];

            if (!script) continue;

            await exec(script, {
              cwd: target,
              env: Object.assign({}, process.env, {
                PATH: `${target}/spm_node_modules/.bin:${process.env.PATH}`,
              }),
            });
          }
        }
      }
    )
  );
  pace.tick();
}

const isVolatileDependency = (
  volatileDependency: PackageTree,
  available: Map<string, string>
): boolean => {
  const availableReference: string | undefined = available.get(
    volatileDependency.name
  );

  if (availableReference === volatileDependency.reference) {
    return false;
  }

  // version check
  if (
    semver.validRange(volatileDependency.reference) &&
    semver.satisfies(availableReference, volatileDependency.reference)
  ) {
    return false;
  }

  return true;
};

async function getPackageDependencyTree(
  pace: ProgressBar,
  { name, reference, dependencies }: PackageTree,
  available: Map<string, string> = new Map()
): Promise<PackageTree> {
  const promiseDependenciesList = dependencies
    .filter((volatileDependency: PackageTree) =>
      isVolatileDependency(volatileDependency, available)
    )
    .map(async (volatileDependency: PackageTree) => {
      pace.total += 1;

      const pinnedDependency = await getPinnedReference(volatileDependency);
      const subDependencies = await getPackageDependencies(pinnedDependency);

      const subAvailable = new Map(available);
      subAvailable.set(pinnedDependency.name, pinnedDependency.reference);

      pace.tick();

      return await getPackageDependencyTree(
        pace,
        Object.assign({}, pinnedDependency, {
          dependencies: subDependencies,
        }),
        subAvailable
      );
    });

  return {
    name,
    reference,
    dependencies: await Promise.all(promiseDependenciesList),
  };
}

async function getPackageDependencies({
  name,
  reference,
}: {
  name: string;
  reference: string;
}): Promise<Array<PackageTree>> {
  const packageBuffer: Buffer = await fetchPackage({ name, reference });
  const buf: Buffer = await readPackageJsonFromArchive(packageBuffer);
  const packageJson: PackageTree = JSON.parse(buf.toString());

  const dependencies: any = packageJson.dependencies || {};

  return Object.keys(dependencies).map((name: string) => ({
    name,
    reference: dependencies[name],
    dependencies,
  }));
}

async function fetchPackage({
  name,
  reference,
}: {
  name: string;
  reference: string;
}): Promise<Buffer> {
  if (['/', './', '../'].some((prefix) => reference.startsWith(prefix))) {
    return await fs.readFile(reference);
  }

  if (semver.valid(reference)) {
    return await fetchPackage({
      name,
      reference: `https://registry.yarnpkg.com/${name}/-/${name}-${reference}.tgz`,
    });
  }

  const response: Response = await fetch(reference);

  if (!response.ok) {
    throw new Error(`Couldn't fetch package "${reference}"`);
  }

  return await response.buffer();
}

async function getPinnedReference({
  name,
  reference,
}: {
  name: string;
  reference: string;
}): Promise<{ name: string; reference: string }> {
  if (semver.validRange(reference) && !semver.valid(reference)) {
    const response = await fetch(`https://registry.yarnpkg.com/${name}`);
    const info = await response.json();

    const versions = Object.keys(info.versions);
    const maxSatisfying = semver.maxSatisfying(versions, reference);

    if (maxSatisfying === null) {
      throw new Error(
        `Couldn't find a version matching "${reference}" for package "${name}"`
      );
    }

    reference = maxSatisfying;
  }
  return { name, reference };
}

function optimizePackageTree({
  name,
  reference,
  dependencies,
}: PackageTree): PackageTree {
  dependencies = dependencies.map((dependency: PackageTree) =>
    optimizePackageTree(dependency)
  );

  for (const hardDependency of dependencies.slice()) {
    for (const subDependency of hardDependency.dependencies.slice()) {
      const availableDependency: PackageTree | undefined = dependencies.find(
        (dependency: PackageTree) => dependency.name === subDependency.name
      );

      // If not availableDependency
      if (typeof availableDependency === 'undefined') {
        dependencies.push(subDependency);
      }

      if (
        !availableDependency ||
        availableDependency.reference === subDependency.reference
      ) {
        hardDependency.dependencies.splice(
          hardDependency.dependencies.findIndex(
            (dependency: PackageTree) => dependency.name === subDependency.name
          )
        );
      }
    }
  }
  return { name, reference, dependencies };
}

(async (): Promise<void> => {
  const cwd: string = process.argv[2] || process.cwd();
  const spmJsonPath: string = path.resolve(cwd, 'spm-package.json'); // TODO: error handling
  const packageJson: any = require(spmJsonPath);

  const destPath: string = path.resolve(process.argv[3] || cwd);

  packageJson.dependencies = Object.keys(packageJson.dependencies || {}).map(
    (name: string): { name: string; reference: string } => ({
      name,
      reference: packageJson.dependencies[name],
    })
  );

  try {
    console.log('Resolving the package tree...');

    const packageTree: PackageTree = await trackProgress((pace: ProgressBar) =>
      getPackageDependencyTree(pace, packageJson)
    );

    console.log('Linking the packages on the filesystem...');

    await trackProgress((pace: ProgressBar) =>
      linkPackages(pace, optimizePackageTree(packageTree), destPath)
    );
  } catch (error) {
    console.log(error.stack);
    process.exit(1);
  }
})();
