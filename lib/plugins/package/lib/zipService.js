'use strict';

/* eslint-disable no-use-before-define */
/* eslint-disable no-param-reassign */

const childProcess = require('child_process');
const archiver = require('archiver');
const BbPromise = require('bluebird');
const path = require('path');
const fs = require('fs');
const globby = require('globby');
const _ = require('lodash');

module.exports = {
  zipService(exclude, include, zipFileName) {
    const params = {
      exclude,
      include,
      zipFileName,
    };

    return BbPromise.bind(this)
      .then(() => BbPromise.resolve(params))
      .then(this.excludeDevDependencies)
      .then(this.zip);
  },

  excludeDevDependencies(params) {
    this.serverless.cli.log(params.zipFileName);
    this.serverless.cli.log(JSON.stringify(params.exclude));
    this.serverless.cli.log(JSON.stringify(params.include));
      
    const servicePath = this.serverless.config.servicePath;
    const exAndInNode = excludeNodeDevDependencies(this, params, servicePath);

    params.exclude = _.union(params.exclude, exAndInNode.exclude);
    params.include = _.union(params.include, exAndInNode.include);

    this.serverless.cli.log(JSON.stringify(params.exclude));
    this.serverless.cli.log(JSON.stringify(params.include));
      
    return BbPromise.resolve(params);
  },

  zip(params) {
    const patterns = ['**'];

    params.exclude.forEach((pattern) => {
      if (pattern.charAt(0) !== '!') {
        patterns.push(`!${pattern}`);
      } else {
        patterns.push(pattern.substring(1));
      }
    });

    // push the include globs to the end of the array
    // (files and folders will be re-added again even if they were excluded beforehand)
    params.include.forEach((pattern) => {
      patterns.push(pattern);
    });

    const zip = archiver.create('zip');
    // Create artifact in temp path and move it to the package path (if any) later
    const artifactFilePath = path.join(this.serverless.config.servicePath,
      '.serverless',
      params.zipFileName
    );
    this.serverless.utils.writeFileDir(artifactFilePath);

    const output = fs.createWriteStream(artifactFilePath);

    const files = globby.sync(patterns, {
      cwd: this.serverless.config.servicePath,
      dot: true,
      silent: true,
      follow: true,
    });

    output.on('open', () => {
      zip.pipe(output);

      files.forEach((filePath) => {
        const fullPath = path.resolve(
          this.serverless.config.servicePath,
          filePath
        );

        const stats = fs.statSync(fullPath);

        if (!stats.isDirectory(fullPath)) {
          zip.append(fs.readFileSync(fullPath), {
            name: filePath,
            mode: stats.mode,
          });
        }
      });

      zip.finalize();
    });

    return new BbPromise((resolve, reject) => {
      output.on('close', () => resolve(artifactFilePath));
      zip.on('error', (err) => reject(err));
    });
  },
};

function excludeNodeDevDependencies(that, params, servicePath) {
  const cwd = process.cwd();
  let exclude = [];
  let include = [];
  let relevantFilePaths = [];

  try {
    
    _.forEach(params.include, (path) => {
      const packageJsonFilePaths = globby.sync([
        path + '/package.json',
        // TODO add glob for node_modules filtering
      ], {
        cwd: servicePath,
        dot: true,
        silent: true,
        follow: true,
        nosort: true,
      });
      relevantFilePaths = _.union(relevantFilePaths, _.filter(packageJsonFilePaths, (filePath) => {
        return !filePath.includes('node_modules');
      }));
      that.serverless.cli.log('RELEVANT --> ' + relevantFilePaths);
    });
      
    _.forEach(relevantFilePaths, (relevantFilePath) => {
      // the path where the package.json file lives
      const rootDirPath = path.join(servicePath, relevantFilePath.replace('/package.json', ''));

      that.serverless.cli.log('DIR --> ' + rootDirPath);

      // TODO replace with package-manager independent directory traversal?!
      const prodDependencies = childProcess
        .execSync('npm ls --prod=true --parseable=true --silent || true', {cwd: rootDirPath})
        .toString().trim();

      const prodDependencyPaths = prodDependencies.match(/(node_modules\/.*)/g);

      let pathToDep = '';
      // if the package.json file is not in the root of the service path
      if (rootDirPath !== servicePath) {
        // the path without the servicePath prepended
        const relativeFilePath = rootDirPath.replace(path.join(servicePath, path.sep), '');
        pathToDep = relativeFilePath ? `${relativeFilePath}/` : '';
      }

      const includePatterns = _.map(prodDependencyPaths, (depPath) =>
        `${pathToDep}${depPath}/**`);

      if (includePatterns.length) {
        // at first exclude the whole node_modules directory
        // after that re-include the production relevant modules
        exclude = _.union(exclude, [`${pathToDep}node_modules/**`]);
        include = _.union(include, includePatterns);
      }
    });
  } catch (e) {
    that.serverless.cli.log(e);
  } finally {
    // make sure to always chdir back to the cwd, no matter what
    process.chdir(cwd);
  }

  return {
    exclude,
    include,
  };
}
