/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

import vscode = require('vscode');
import path = require('path');
import { getMonkey2RuntimePath, getBinPathWithPreferredMonkey2path, resolvePath, getInferredMonkey2Path } from './m2Path';
import cp = require('child_process');
import TelemetryReporter from 'vscode-extension-telemetry';
import fs = require('fs');

const extensionId: string = 'nitrologic.monkey2';
const extensionVersion: string = vscode.extensions.getExtension(extensionId).packageJSON.version;
const aiKey: string = 'AIF-56fe259a-f869-438a-9eff-928c454c1ec4';

export const monkey2Keywords: string[] = [
	'End',
	'Funcion',
	'Print'
];

export interface SemVersion {
	major: number;
	minor: number;
	rev: number;
}

let mx2ccVersion: SemVersion = null;
let vendorSupport: boolean = null;
let telemtryReporter: TelemetryReporter;

export function byteOffsetAt(document: vscode.TextDocument, position: vscode.Position): number {
	let offset = document.offsetAt(position);
	let text = document.getText();
	return Buffer.byteLength(text.substr(0, offset));
}

export interface Prelude {
	imports: Array<{ kind: string; start: number; end: number; }>;
	pkg: { start: number; end: number; name: string };
}

export function parseFilePrelude(text: string): Prelude {
	let lines = text.split('\n');
	let ret: Prelude = { imports: [], pkg: null };
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		let pkgMatch = line.match(/^(\s)*package(\s)+(\w+)/);
		if (pkgMatch) {
			ret.pkg = { start: i, end: i, name: pkgMatch[3] };
		}
		if (line.match(/^(\s)*import(\s)+\(/)) {
			ret.imports.push({ kind: 'multi', start: i, end: -1 });
		}
		if (line.match(/^(\s)*import(\s)+[^\(]/)) {
			ret.imports.push({ kind: 'single', start: i, end: i });
		}
		if (line.match(/^(\s)*\)/)) {
			if (ret.imports[ret.imports.length - 1].end === -1) {
				ret.imports[ret.imports.length - 1].end = i;
			}
		}
		if (line.match(/^(\s)*(func|const|type|var)/)) {
			break;
		}
	}
	return ret;
}

// Takes a Go function signature like:
//     (foo, bar string, baz number) (string, string)
// and returns an array of parameter strings:
//     ["foo", "bar string", "baz string"]
// Takes care of balancing parens so to not get confused by signatures like:
//     (pattern string, handler func(ResponseWriter, *Request)) {
export function parameters(signature: string): string[] {
	let ret: string[] = [];
	let parenCount = 0;
	let lastStart = 1;
	for (let i = 1; i < signature.length; i++) {
		switch (signature[i]) {
			case '(':
				parenCount++;
				break;
			case ')':
				parenCount--;
				if (parenCount < 0) {
					if (i > lastStart) {
						ret.push(signature.substring(lastStart, i));
					}
					return ret;
				}
				break;
			case ',':
				if (parenCount === 0) {
					ret.push(signature.substring(lastStart, i));
					lastStart = i + 2;
				}
				break;
		}
	}
	return null;
}

export function canonicalizeM2PATHPrefix(filename: string): string {
	let gopath: string = getCurrentMonkey2Path();
	if (!gopath) return filename;
	let workspaces = gopath.split(path.delimiter);
	let filenameLowercase = filename.toLowerCase();

	// In case of multiple workspaces, find current workspace by checking if current file is
	// under any of the workspaces in $M2PATH
	let currentWorkspace: string = null;
	for (let workspace of workspaces) {
		// In case of nested workspaces, (example: both /Users/me and /Users/me/a/b/c are in $M2PATH)
		// both parent & child workspace in the nested workspaces pair can make it inside the above if block
		// Therefore, the below check will take longer (more specific to current file) of the two
		if (filenameLowercase.substring(0, workspace.length) === workspace.toLowerCase()
			&& (!currentWorkspace || workspace.length > currentWorkspace.length)) {
			currentWorkspace = workspace;
		}
	}

	if (!currentWorkspace) return filename;
	return currentWorkspace + filename.slice(currentWorkspace.length);
}

/**
 * Gets version of Go based on the output of the command `go version`.
 * Returns null if go is being used from source/tip in which case `go version` will not return release tag like go1.6.3
 */
export function getMonkey2Version(): Promise<SemVersion> {
	let m2RuntimePath = getMonkey2RuntimePath();

	if (!m2RuntimePath) {
		vscode.window.showInformationMessage('Cannot find "mx2cc" binary. Update PATH or M2ROOT appropriately');
		return Promise.resolve(null);
	}

	if (mx2ccVersion) {
		sendTelemetryEvent('getMonkey2Version', { version: `${mx2ccVersion.major}.${mx2ccVersion.minor}` });
		return Promise.resolve(mx2ccVersion);
	}
	return new Promise<SemVersion>((resolve, reject) => {
		cp.execFile(m2RuntimePath, [], {}, (err, stdout, stderr) => {
			let matches = /Mx2cc version (\d).(\d).(\d+).*/.exec(stdout);
			if (matches) {
				mx2ccVersion = {
					major: parseInt(matches[1]),
					minor: parseInt(matches[2]),
					rev: parseInt(matches[3])					
				};
				sendTelemetryEvent('getMonkey2Version', { version: `${mx2ccVersion.major}.${mx2ccVersion.minor}.${mx2ccVersion.rev}` });
			} else {
				sendTelemetryEvent('getMonkey2Version', { version: stdout });
			}
			return resolve(mx2ccVersion);
		});
	});
}

/**
 * Returns boolean denoting if current version of Go supports vendoring
 */
export function isVendorSupported(): Promise<boolean> {
	if (vendorSupport != null) {
		return Promise.resolve(vendorSupport);
	}
	return getMonkey2Version().then(version => {
		if (!version) {
			return process.env['GO15VENDOREXPERIMENT'] === '0' ? false : true;
		}

		switch (version.major) {
			case 0:
				vendorSupport = false;
				break;
			case 1:
				vendorSupport = (version.minor > 6 || ((version.minor === 5 || version.minor === 6) && process.env['GO15VENDOREXPERIMENT'] === '1')) ? true : false;
				break;
			default:
				vendorSupport = true;
				break;
		}
		return vendorSupport;
	});
}

/**
 * Returns boolean indicating if M2PATH is set or not
 * If not set, then prompts user to do set M2PATH
 */
export function isMonkey2PathSet(): boolean {
	if (!getCurrentMonkey2Path()) {
		vscode.window.showInformationMessage('Set M2PATH environment variable and restart VS Code or set monkey2.path in Workspace settings', 'Set monkey2.path in Workspace Settings').then(selected => {
			if (selected === 'Set monkey2.path in Workspace Settings') {
				let settingsFilePath = path.join(vscode.workspace.rootPath, '.vscode', 'settings.json');
				vscode.commands.executeCommand('vscode.open', vscode.Uri.file(settingsFilePath));
			}
		});
		return false;
	}

	return true;
}

export function sendTelemetryEvent(eventName: string, properties?: {
	[key: string]: string;
}, measures?: {
	[key: string]: number;
}): void {

	let temp = vscode.extensions.getExtension(extensionId).packageJSON.contributes;
	telemtryReporter = telemtryReporter ? telemtryReporter : new TelemetryReporter(extensionId, extensionVersion, aiKey);
	telemtryReporter.sendTelemetryEvent(eventName, properties, measures);
}

export function isPositionInString(document: vscode.TextDocument, position: vscode.Position): boolean {
	let lineText = document.lineAt(position.line).text;
	let lineTillCurrentPosition = lineText.substr(0, position.character);

	// Count the number of double quotes in the line till current position. Ignore escaped double quotes
	let doubleQuotesCnt = (lineTillCurrentPosition.match(/\"/g) || []).length;
	let escapedDoubleQuotesCnt = (lineTillCurrentPosition.match(/\\\"/g) || []).length;

	doubleQuotesCnt -= escapedDoubleQuotesCnt;
	return doubleQuotesCnt % 2 === 1;
}

export function getToolsGopath(): string {
	let m2Config = vscode.workspace.getConfiguration('monkey2');
	let toolsGopath = m2Config['toolsGopath'];
	if (toolsGopath) {
		toolsGopath = resolvePath(toolsGopath, vscode.workspace.rootPath);
	}
	return toolsGopath;
}

export function getBinPath(tool: string): string {
	return getBinPathWithPreferredMonkey2path(tool, getToolsGopath(), getCurrentMonkey2Path());
}

export function getFileArchive(document: vscode.TextDocument): string {
	let fileContents = document.getText();
	return document.fileName + '\n' + Buffer.byteLength(fileContents, 'utf8') + '\n' + fileContents;
}

export function getToolsEnvVars(): any {
	let toolsEnvVars = vscode.workspace.getConfiguration('monkey2')['toolsEnvVars'];

	let gopath = getCurrentMonkey2Path();

	let envVars = Object.assign({}, process.env, gopath ? { M2PATH: gopath } : {});

	if (!toolsEnvVars || typeof toolsEnvVars !== 'object' || Object.keys(toolsEnvVars).length === 0) {
		return envVars;
	}
	return Object.assign(envVars, toolsEnvVars);
}

export function getCurrentMonkey2Path(): string {
	let config = vscode.workspace.getConfiguration('monkey2');
	let configM2Path = config['path'];
	let inferredMonkey2path;
	if (config['inferPath'] === true) {
		inferredMonkey2path = getInferredMonkey2Path(vscode.workspace.rootPath);
	}

	return inferredMonkey2path ? inferredMonkey2path : (configM2Path ? resolvePath(configM2Path, vscode.workspace.rootPath) : process.env['M2PATH']);
}

export function getExtensionCommands(): any[] {
	let pkgJSON = vscode.extensions.getExtension(extensionId).packageJSON;
	if (!pkgJSON.contributes || !pkgJSON.contributes.commands) {
		return;
	}
	let extensionCommands: any[] = vscode.extensions.getExtension(extensionId).packageJSON.contributes.commands.filter(x => x.command !== 'go.show.commands');
	return extensionCommands;
}

export class LineBuffer {
	private buf: string = '';
	private lineListeners: { (line: string): void; }[] = [];
	private lastListeners: { (last: string): void; }[] = [];

	append(chunk: string) {
		this.buf += chunk;
		do {
			const idx = this.buf.indexOf('\n');
			if (idx === -1) {
				break;
			}

			this.fireLine(this.buf.substring(0, idx));
			this.buf = this.buf.substring(idx + 1);
		} while (true);
	}

	done() {
		this.fireDone(this.buf !== '' ? this.buf : null);
	}

	private fireLine(line: string) {
		this.lineListeners.forEach(listener => listener(line));
	}

	private fireDone(last: string) {
		this.lastListeners.forEach(listener => listener(last));
	}

	onLine(listener: (line: string) => void) {
		this.lineListeners.push(listener);
	}

	onDone(listener: (last: string) => void) {
		this.lastListeners.push(listener);
	}
}
