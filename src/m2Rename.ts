/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import cp = require('child_process');
import { getBinPath, byteOffsetAt, canonicalizeGOPATHPrefix, getToolsEnvVars } from './util';
import { getEditsFromUnifiedDiffStr, isDiffToolAvailable, FilePatch, Edit } from './diffUtils';
import { promptForMissingTool } from './m2InstallTools';

export class GoRenameProvider implements vscode.RenameProvider {

	public provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Thenable<vscode.WorkspaceEdit> {
		return vscode.workspace.saveAll(false).then(() => {
			return this.doRename(document, position, newName, token);
		});
	}

	private doRename(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Thenable<vscode.WorkspaceEdit> {
		return new Promise<vscode.WorkspaceEdit>((resolve, reject) => {
			let filename = canonicalizeGOPATHPrefix(document.fileName);
			let range = document.getWordRangeAtPosition(position);
			let pos = range ? range.start : position;
			let offset = byteOffsetAt(document, pos);
			let env = getToolsEnvVars();
			let gorename = getBinPath('gorename');
			let buildTags = '"' + vscode.workspace.getConfiguration('go')['buildTags'] + '"';
			let gorenameArgs = ['-offset', filename + ':#' + offset, '-to', newName, '-tags', buildTags];
			let canRenameToolUseDiff = isDiffToolAvailable();
			if (canRenameToolUseDiff) {
				gorenameArgs.push('-d');
			}

			cp.execFile(gorename, gorenameArgs, {env}, (err, stdout, stderr) => {
				try {
					if (err && (<any>err).code === 'ENOENT') {
						promptForMissingTool('gorename');
						return resolve(null);
					}
					if (err) {
						let errMsg = stderr ? 'Rename failed: ' + stderr.replace(/\n/g, ' ') : 'Rename failed';
						console.log(errMsg);
						return reject(errMsg);
					}

					let result = new vscode.WorkspaceEdit();

					if (canRenameToolUseDiff) {
						let filePatches = getEditsFromUnifiedDiffStr(stdout);
						filePatches.forEach((filePatch: FilePatch) => {
							let fileUri = vscode.Uri.file(filePatch.fileName);
							filePatch.edits.forEach((edit: Edit) => {
								edit.applyUsingWorkspaceEdit(result, fileUri);
							});
						});
					}

					return resolve(result);
				} catch (e) {
					reject(e);
				}
			});
		});
	}

}
