/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

/**
 * This file is loaded by both the extension and debug adapter, so it cannot import 'vscode'
 */
import fs = require('fs');
import path = require('path');
import os = require('os');

let binPathCache: { [bin: string]: string; } = {};
let runtimePathCache: string = '';

export function getBinPathFromEnvVar(toolName: string, envVarValue: string, appendBinToPath: boolean): string {
	toolName = correctBinname(toolName);
	if (envVarValue) {
		let paths = envVarValue.split(path.delimiter);
		for (let i = 0; i < paths.length; i++) {
			let binpath = path.join(paths[i], appendBinToPath ? 'bin' : '', toolName);
			if (fileExists(binpath)) {
				binPathCache[toolName] = binpath;
				return binpath;
			}
		}
	}
	return null;
}

export function getBinPathWithPreferredMonkey2path(binname: string, ...preferredGopaths) {
	if (binPathCache[correctBinname(binname)]) return binPathCache[correctBinname(binname)];

	for (let i = 0; i < preferredGopaths.length; i++) {
		if (typeof preferredGopaths[i] === 'string') {
			// Search in the preferred M2PATH workspace's bin folder
			let pathFrompreferredGoPath = getBinPathFromEnvVar(binname, preferredGopaths[i], true);
			if (pathFrompreferredGoPath) {
				return pathFrompreferredGoPath;
			}
		}
	}

	// Then search PATH parts
	let pathFromPath = getBinPathFromEnvVar(binname, process.env['PATH'], false);
	if (pathFromPath) {
		return pathFromPath;
	}

	// Finally check M2ROOT just in case
	let pathFromM2Root = getBinPathFromEnvVar(binname, process.env['M2ROOT'], true);
	if (pathFromM2Root) {
		return pathFromM2Root;
	}

	// Else return the binary name directly (this will likely always fail downstream)
	return binname;
}

function correctBinname(binname: string) {
	if (process.platform === 'win32')
		return binname + '_windows.exe';
	else
		return binname + '_linux';
}

/**
 * Returns Monkey2 binary path.
 *
 * @return the path to the mx2cc binary.
 */
export function getMonkey2RuntimePath(): string {
	if (runtimePathCache) return runtimePathCache;
	let correctBinName = correctBinname('mx2cc');
	if (process.env['M2ROOT']) {
		let runtimePathFromM2Root = path.join(process.env['M2ROOT'], 'bin', correctBinName);
		if (fileExists(runtimePathFromM2Root)) {
			runtimePathCache = runtimePathFromM2Root;
			return runtimePathCache;
		}
	}

	if (process.env['PATH']) {
		let pathparts = (<string>process.env.PATH).split(path.delimiter);
		runtimePathCache = pathparts.map(dir => path.join(dir, correctBinName)).filter(candidate => fileExists(candidate))[0];
	}
	if (!runtimePathCache) {
		let defaultPathForGo = process.platform === 'win32' ? 'C:\\Monkey2\\bin\\mx2cc_windows.exe' : '/usr/local/monkey2/bin/mx2cc_linux';
		if (fileExists(defaultPathForGo)) {
			runtimePathCache = defaultPathForGo;
		}
	}
	return runtimePathCache;
}

function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch (e) {
		return false;
	}
}

export function clearCacheForTools() {
	binPathCache = {};
}

/**
 * Exapnds ~ to homedir in non-Windows platform and replaces ${workspaceRoot} token with given workspaceroot
 */
export function resolvePath(inputPath: string, workspaceRoot?: string): string {
	if (!inputPath || !inputPath.trim()) return inputPath;
	if (workspaceRoot) {
		inputPath = inputPath.replace(/\${workspaceRoot}/g, workspaceRoot);
	}
	return inputPath.startsWith('~') ? path.join(os.homedir(), inputPath.substr(1)) : inputPath;
}

export function stripBOM(s: string): string {
	if (s && s[0] === '\uFEFF') {
		s = s.substr(1);
	}
	return s;
}

export function parseEnvFile(path: string): { [key: string]: string } {
	const env = {};
	if (!path) {
		return env;
	}

	try {
		const buffer = stripBOM(fs.readFileSync(path, 'utf8'));
		buffer.split('\n').forEach(line => {
			const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
			if (r !== null) {
				let value = r[2] || '';
				if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
					value = value.replace(/\\n/gm, '\n');
				}
				env[r[1]] = value.replace(/(^['"]|['"]$)/g, '');
			}
		});
		return env;
	} catch (e) {
		throw (`Cannot load environment variables from file ${path}`);
	}
}

// Walks up given folder path to return the closest ancestor that has `modules` as a child
export function getInferredMonkey2Path(folderPath: string): string {
	let dirs = folderPath.toLowerCase().split(path.sep);

	// find src directory closest to given folder path
	let srcIdx = dirs.lastIndexOf('monkey2');
	if (srcIdx > 0) {
		return folderPath.substr(0, dirs.slice(0, srcIdx).join(path.sep).length);
	}
}

/**
 * Returns the workspace in the given Gopath to which given directory path belongs to
 * @param m2path string Current path. Can be ; or : separated (as per os) to support multiple paths
 * @param currentFileDirPath string
 */
export function getCurrentWorkspaceFromM2PATH(m2path: string, currentFileDirPath: string): string {
	let workspaces: string[] = m2path.split(path.delimiter);
	let currentWorkspace = '';

	// Workaround for issue in https://github.com/Microsoft/vscode/issues/9448#issuecomment-244804026
	if (process.platform === 'win32') {
		currentFileDirPath = currentFileDirPath.substr(0, 1).toUpperCase() + currentFileDirPath.substr(1);
	}

	// Find current workspace by checking if current file is
	// under any of the workspaces in $M2PATH
	for (let i = 0; i < workspaces.length; i++) {
		let possibleCurrentWorkspace = path.join(workspaces[i], 'modules');
		if (currentFileDirPath.startsWith(possibleCurrentWorkspace)) {
			// In case of nested workspaces, (example: both /Users/me and /Users/me/src/a/b/c are in $M2PATH)
			// both parent & child workspace in the nested workspaces pair can make it inside the above if block
			// Therefore, the below check will take longer (more specific to current file) of the two
			if (possibleCurrentWorkspace.length > currentWorkspace.length) {
				currentWorkspace = possibleCurrentWorkspace;
			}
		}
	}
	return currentWorkspace;
}