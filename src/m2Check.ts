/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import cp = require('child_process');
import path = require('path');
import os = require('os');
import fs = require('fs');
import { getMonkey2RuntimePath, resolvePath, getCurrentWorkspaceFromM2PATH } from './m2Path';
import { getCoverage } from './m2Cover';
import { outputChannel } from './m2Status';
import { promptForMissingTool } from './m2InstallTools';
import { goTest } from './testUtils';
import { getBinPath, parseFilePrelude, getCurrentMonkey2Path, getToolsEnvVars } from './util';
import { getNonVendorPackages } from './m2Packages';

let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
statusBarItem.command = 'm2.test.showOutput';

export function removeTestStatus(e: vscode.TextDocumentChangeEvent) {
	if (e.document.isUntitled) {
		return;
	}
	statusBarItem.hide();
	statusBarItem.text = '';
}

export interface ICheckResult {
	file: string;
	line: number;
	msg: string;
	severity: string;
}

/**
 * Runs given Go tool and returns errors/warnings that can be fed to the Problems Matcher
 * @param args Arguments to be passed while running given tool
 * @param cwd cwd that will passed in the env object while running given tool
 * @param severity error or warning
 * @param useStdErr If true, the stderr of the output of the given tool will be used, else stdout will be used
 * @param toolName The name of the Go tool to run. If none is provided, the go runtime itself is used
 * @param printUnexpectedOutput If true, then output that doesnt match expected format is printed to the output channel
 */
function runTool(args: string[], cwd: string, severity: string, useStdErr: boolean, toolName: string, env: any, printUnexpectedOutput?: boolean): Promise<ICheckResult[]> {
	let m2RuntimePath = getMonkey2RuntimePath();
	let cmd = toolName ? getBinPath(toolName) : m2RuntimePath;
	return new Promise((resolve, reject) => {
		cp.execFile(cmd, args, { env: env, cwd: cwd }, (err, stdout, stderr) => {
			try {
				if (err && (<any>err).code === 'ENOENT') {
					// Since the tool is run on save which can be frequent
					// we avoid sending explicit notification if tool is missing
					console.log(`Cannot find ${toolName ? toolName : m2RuntimePath}`);
					return resolve([]);
				}
				if (err && stderr && !useStdErr) {
					outputChannel.appendLine(['Error while running tool:', cmd, ...args].join(' '));
					outputChannel.appendLine(stderr);
					return resolve([]);
				}
				let lines = (useStdErr ? stderr : stdout).toString().split('\n');
				outputChannel.appendLine(['Finished running tool:', cmd, ...args].join(' '));

				let ret: ICheckResult[] = [];
				let unexpectedOutput = false;
				let atleastSingleMatch = false;
				for (let i = 0; i < lines.length; i++) {
					if (lines[i][0] === '\t' && ret.length > 0) {
						ret[ret.length - 1].msg += '\n' + lines[i];
						continue;
					}
					let match = /^([^:]*: )?((.:)?[^:]*):(\d+)(:(\d+)?)?:(?:\w+:)? (.*)$/.exec(lines[i]);
					if (!match) {
						if (printUnexpectedOutput && useStdErr && stderr) unexpectedOutput = true;
						continue;
					}
					atleastSingleMatch = true;
					let [_, __, file, ___, lineStr, ____, charStr, msg] = match;
					let line = +lineStr;

					// Building skips vendor folders,
					// But vet and lint take in directories and not import paths, so no way to skip them
					// So prune out the results from vendor folders herehere.
					if (!path.isAbsolute(file) && (file.startsWith(`vendor${path.sep}`) || file.indexOf(`${path.sep}vendor${path.sep}`) > -1)) {
						continue;
					}

					file = path.resolve(cwd, file);
					ret.push({ file, line, msg, severity });
					outputChannel.appendLine(`${file}:${line}: ${msg}`);
				}
				if (!atleastSingleMatch && unexpectedOutput && vscode.window.activeTextEditor) {
					outputChannel.appendLine(stderr);
					if (err) {
						ret.push({
							file: vscode.window.activeTextEditor.document.fileName,
							line: 1,
							msg: stderr,
							severity: 'error'
						});
					}
				}
				outputChannel.appendLine('');
				resolve(ret);
			} catch (e) {
				reject(e);
			}
		});
	});
}

export function check(filename: string, m2Config: vscode.WorkspaceConfiguration): Promise<ICheckResult[]> {
	outputChannel.clear();
	let runningToolsPromises = [];
	let cwd = path.dirname(filename);
	let env = getToolsEnvVars();
	let m2RuntimePath = getMonkey2RuntimePath();

	if (!m2RuntimePath) {
		vscode.window.showInformationMessage('Cannot find "mx2cc" binary. Update PATH or M2ROOT appropriately');
		return Promise.resolve([]);
	}

	let testPromise: Thenable<boolean>;
	let tmpCoverPath;
	let runTest = () => {
		if (testPromise) {
			return testPromise;
		}

		let buildFlags = m2Config['testFlags'] || m2Config['buildFlags'] || [];

		let args = buildFlags;
		if (m2Config['coverOnSave']) {
			tmpCoverPath = path.normalize(path.join(os.tmpdir(), 'go-code-cover'));
			args = ['-coverprofile=' + tmpCoverPath, ...buildFlags];
		}

		testPromise = goTest({
			m2Config: m2Config,
			dir: cwd,
			flags: args,
			background: true
		});
		return testPromise;
	};

	if (!!m2Config['buildOnSave'] && m2Config['buildOnSave'] !== 'off') {
		const tmpPath = path.normalize(path.join(os.tmpdir(), 'go-code-check'));
		let buildFlags = m2Config['buildFlags'] || [];
		// Remove the -i flag as it will be added later anyway
		if (buildFlags.indexOf('-i') > -1) {
			buildFlags.splice(buildFlags.indexOf('-i'), 1);
		}

		// We use `go test` instead of `go build` because the latter ignores test files
		let buildArgs: string[] = ['test', '-i', '-c', '-o', tmpPath, ...buildFlags];
		if (m2Config['buildTags'] && buildFlags.indexOf('-tags') === -1) {
			buildArgs.push('-tags');
			buildArgs.push('"' + m2Config['buildTags'] + '"');
		}

		if (m2Config['buildOnSave'] === 'workspace') {
			let buildPromises = [];
			let outerBuildPromise = getNonVendorPackages(vscode.workspace.rootPath).then(pkgs => {
				buildPromises = pkgs.map(pkgPath => {
					return runTool(
						buildArgs.concat(pkgPath),
						cwd,
						'error',
						true,
						null,
						env,
						true
					);
				});
				return Promise.all(buildPromises).then((resultSets) => {
					return Promise.resolve([].concat.apply([], resultSets));
				});
			});
			runningToolsPromises.push(outerBuildPromise);
		} else {
			// Find the right importPath instead of directly using `.`. Fixes https://github.com/Microsoft/vscode-go/issues/846
			let currentWorkspace = getCurrentWorkspaceFromM2PATH(getCurrentMonkey2Path(), cwd);
			let importPath = currentWorkspace ? cwd.substr(currentWorkspace.length + 1) : '.';

			runningToolsPromises.push(runTool(
				buildArgs.concat(importPath),
				cwd,
				'error',
				true,
				null,
				env,
				true
			));
		}
	}

	if (!!m2Config['testOnSave']) {
		statusBarItem.show();
		statusBarItem.text = 'Tests Running';
		runTest().then(success => {
			if (statusBarItem.text === '') {
				return;
			}
			if (success) {
				statusBarItem.text = 'Tests Passed';
			} else {
				statusBarItem.text = 'Tests Failed';
			}
		});
	}

	if (!!m2Config['lintOnSave'] && m2Config['lintOnSave'] !== 'off') {
		let lintTool = m2Config['lintTool'] || 'golint';
		let lintFlags: string[] = m2Config['lintFlags'] || [];
		let lintEnv = Object.assign({}, env);
		let args = [];
		let configFlag = '--config=';
		lintFlags.forEach(flag => {
			// --json is not a valid flag for golint and in gometalinter, it is used to print output in json which we dont want
			if (flag === '--json') {
				return;
			}
			if (flag.startsWith(configFlag)) {
				let configFilePath = flag.substr(configFlag.length);
				configFilePath = resolvePath(configFilePath, vscode.workspace.rootPath);
				args.push(`${configFlag}${configFilePath}`);
				return;
			}
			args.push(flag);
		});
		if (lintTool === 'gometalinter') {
			if (args.indexOf('--aggregate') === -1) {
				args.push('--aggregate');
			}
			if (m2Config['toolsGopath']) {
				// gometalinter will expect its linters to be in the M2PATH
				// So add the toolsGopath to M2PATH
				lintEnv['M2PATH'] += path.delimiter + m2Config['toolsGopath'];
			}
		}

		let lintWorkDir = cwd;

		if (m2Config['lintOnSave'] === 'workspace') {
			args.push('./...');
			lintWorkDir = vscode.workspace.rootPath;
		}

		runningToolsPromises.push(runTool(
			args,
			lintWorkDir,
			'warning',
			false,
			lintTool,
			lintEnv
		));
	}

	if (!!m2Config['vetOnSave'] && m2Config['vetOnSave'] !== 'off') {
		let vetFlags = m2Config['vetFlags'] || [];
		let vetArgs = ['tool', 'vet', ...vetFlags, '.'];
		let vetWorkDir = cwd;

		if (m2Config['vetOnSave'] === 'workspace') {
			vetWorkDir = vscode.workspace.rootPath;
		}

		runningToolsPromises.push(runTool(
			vetArgs,
			vetWorkDir,
			'warning',
			true,
			null,
			env
		));
	}

	if (!!m2Config['coverOnSave']) {
		runTest().then(success => {
			if (!success) {
				return [];
			}
			// FIXME: it's not obvious that tmpCoverPath comes from runTest()
			return getCoverage(tmpCoverPath);
		});
	}

	return Promise.all(runningToolsPromises).then(resultSets => [].concat.apply([], resultSets));
}
