/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

import cp = require('child_process');
import path = require('path');
import vscode = require('vscode');
import util = require('util');
import { parseEnvFile, getMonkey2RuntimePath, resolvePath } from './m2Path';
import { getToolsEnvVars, LineBuffer } from './util';
import { GoDocumentSymbolProvider } from './m2Outline';
import { getNonVendorPackages } from './m2Packages';

let outputChannel = vscode.window.createOutputChannel('Go Tests');


/**
 * Input to goTest.
 */
export interface TestConfig {
	/**
	 * The working directory for `go test`.
	 */
	dir: string;
	/**
	 * Configuration for the Go extension
	 */
	goConfig: vscode.WorkspaceConfiguration;
	/**
	 * Test flags to override the testFlags and buildFlags from goConfig.
	 */
	flags: string[];
	/**
	 * Specific function names to test.
	 */
	functions?: string[];
	/**
	 * Test was not requested explicitly. The output should not appear in the UI.
	 */
	background?: boolean;
	/**
	 * Run all tests from all sub directories under `dir`
	 */
	includeSubDirectories?: boolean;
}

export function getTestEnvVars(config: vscode.WorkspaceConfiguration): any {
	const toolsEnv = getToolsEnvVars();
	const testEnv = config['testEnvVars'] || {};

	let fileEnv = {};
	let testEnvFile = config['testEnvFile'];
	if (testEnvFile) {
		testEnvFile = resolvePath(testEnvFile, vscode.workspace.rootPath);
		try {
			fileEnv = parseEnvFile(testEnvFile);
		} catch (e) {
			console.log(e);
		}
	}

	return Object.assign({}, toolsEnv, fileEnv, testEnv);
}

export function getTestFlags(goConfig: vscode.WorkspaceConfiguration, args: any): string[] {
	let testFlags: string[] = goConfig['testFlags'] ? goConfig['testFlags'] : goConfig['buildFlags'];
	testFlags = [...testFlags]; // Use copy of the flags, dont pass the actual object from config
	return (args && args.hasOwnProperty('flags') && Array.isArray(args['flags'])) ? args['flags'] : testFlags;
}

/**
 * Returns all Go unit test functions in the given source file.
 *
 * @param the URI of a Go source file.
 * @return test function symbols for the source file.
 */
export function getTestFunctions(doc: vscode.TextDocument): Thenable<vscode.SymbolInformation[]> {
	let documentSymbolProvider = new GoDocumentSymbolProvider();
	return documentSymbolProvider
		.provideDocumentSymbols(doc, null)
		.then(symbols =>
			symbols.filter(sym =>
				sym.kind === vscode.SymbolKind.Function
				&& hasTestFunctionPrefix(sym.name))
		);
}

/**
 * Returns whether a given function name has a test prefix.
 * Test functions have "Test" or "Example" as a prefix.
 *
 * @param the function name.
 * @return whether the name has a test function prefix.
 */
function hasTestFunctionPrefix(name: string): boolean {
	return name.startsWith('Test') || name.startsWith('Example');
}

/**
 * Runs go test and presents the output in the 'Go' channel.
 *
 * @param goConfig Configuration for the Go extension.
 */
export function goTest(testconfig: TestConfig): Thenable<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		outputChannel.clear();
		if (!testconfig.background) {

			outputChannel.show(true);
		}

		let buildTags: string = testconfig.goConfig['buildTags'];
		let args = ['test', ...testconfig.flags, '-timeout', testconfig.goConfig['testTimeout']];
		if (buildTags && testconfig.flags.indexOf('-tags') === -1) {
			args.push('-tags');
			args.push(buildTags);
		}
		let testEnvVars = getTestEnvVars(testconfig.goConfig);
		let m2RuntimePath = getMonkey2RuntimePath();

		if (!m2RuntimePath) {
			vscode.window.showInformationMessage('Cannot find "mxc22" binary. Update PATH or M2ROOT appropriately');
			return Promise.resolve();
		}

		targetArgs(testconfig).then(targets => {
			let outTargets = args.slice(0);
			if (targets.length > 2) {
				outTargets.push('<long arguments omitted>');
			} else {
				outTargets.push(...targets);
			}
			outputChannel.appendLine(['Running tool:', m2RuntimePath, ...outTargets].join(' '));
			outputChannel.appendLine('');

			args.push(...targets);

			let proc = cp.spawn(m2RuntimePath, args, { env: testEnvVars, cwd: testconfig.dir });
			const outBuf = new LineBuffer();
			const errBuf = new LineBuffer();

			outBuf.onLine(line => outputChannel.appendLine(expandFilePathInOutput(line, testconfig.dir)));
			outBuf.onDone(last => last && outputChannel.appendLine(expandFilePathInOutput(last, testconfig.dir)));

			errBuf.onLine(line => outputChannel.appendLine(line));
			errBuf.onDone(last => last && outputChannel.appendLine(last));

			proc.stdout.on('data', chunk => outBuf.append(chunk.toString()));
			proc.stderr.on('data', chunk => errBuf.append(chunk.toString()));

			proc.on('close', code => {
				outBuf.done();
				errBuf.done();

				if (code) {
					outputChannel.appendLine('Error: Tests failed.');
				} else {
					outputChannel.appendLine('Success: Tests passed.');
				}
				resolve(code === 0);
			});
		}, err => {
			outputChannel.appendLine('Error: Tests failed.');
			outputChannel.appendLine(err);
			resolve(false);
		});
	});
}

/**
 * Reveals the output channel in the UI.
 */
export function showTestOutput() {
	outputChannel.show(true);
}

function expandFilePathInOutput(output: string, cwd: string): string {
	let lines = output.split('\n');
	for (let i = 0; i < lines.length; i++) {
		let matches = lines[i].match(/^\s+(\S+_test.go):(\d+):/);
		if (matches) {
			lines[i] = lines[i].replace(matches[1], path.join(cwd, matches[1]));
		}
	}
	return lines.join('\n');
}

/**
 * Get the test target arguments.
 *
 * @param testconfig Configuration for the Go extension.
 */
function targetArgs(testconfig: TestConfig): Thenable<Array<string>> {
	if (testconfig.functions) {
		return new Promise<Array<string>>((resolve, reject) => {
			const args = [];
			args.push('-run');
			args.push(util.format('^%s$', testconfig.functions.join('|')));
			return resolve(args);
		});
	} else if (testconfig.includeSubDirectories) {
		return getNonVendorPackages(vscode.workspace.rootPath);
	}
	return Promise.resolve([]);
}