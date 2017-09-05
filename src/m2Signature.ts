/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import cp = require('child_process');
import vscode = require('vscode');
import { languages, window, commands, SignatureHelpProvider, SignatureHelp, SignatureInformation, ParameterInformation, TextDocument, Position, Range, CancellationToken, WorkspaceConfiguration, workspace } from 'vscode';
import { definitionLocation } from './m2Declaration';
import { parameters } from './util';

export class GoSignatureHelpProvider implements SignatureHelpProvider {
	private goConfig = null;

	constructor(goConfig?: WorkspaceConfiguration) {
		this.goConfig = goConfig;
		if (!this.goConfig) {
			this.goConfig = vscode.workspace.getConfiguration('go');
		}
	}

	public provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken): Promise<SignatureHelp> {
		let theCall = this.walkBackwardsToBeginningOfCall(document, position);
		if (theCall == null) {
			return Promise.resolve(null);
		}
		let callerPos = this.previousTokenPosition(document, theCall.openParen);
		// Temporary fix to fall back to godoc if guru is the set docsTool
		let goConfig = this.goConfig;
		if (goConfig['docsTool'] === 'guru') {
			goConfig = Object.assign({}, goConfig, {'docsTool': 'godoc'});
		}
		return definitionLocation(document, callerPos, goConfig).then(res => {
			if (!res) {
				// The definition was not found
				return null;
			}
			if (res.line === callerPos.line) {
				// This must be a function definition
				return null;
			}
			let result = new SignatureHelp();
			let declarationText, sig: string;
			let si: SignatureInformation;
			if (res.toolUsed === 'godef') {
				// declaration is of the form "Add func(a int, b int) int"
				declarationText = res.declarationlines[0];
				let nameEnd = declarationText.indexOf(' ');
				let sigStart = nameEnd + 5; // ' func'
				let funcName = declarationText.substring(0, nameEnd);
				sig = declarationText.substring(sigStart);
				si = new SignatureInformation(funcName + sig, res.doc);
			} else if (res.toolUsed === 'gogetdoc') {
				// declaration is of the form "func Add(a int, b int) int"
				declarationText = res.declarationlines[0].substring(5);
				let funcNameStart = declarationText.indexOf(res.name + '('); // Find 'functionname(' to remove anything before it
				if (funcNameStart > 0) {
					declarationText = declarationText.substring(funcNameStart);
				}
				si = new SignatureInformation(declarationText, res.doc);
				sig = declarationText.substring(res.name.length);
			}

			si.parameters = parameters(sig).map(paramText =>
				new ParameterInformation(paramText)
			);
			result.signatures = [si];
			result.activeSignature = 0;
			result.activeParameter = Math.min(theCall.commas.length, si.parameters.length - 1);
			return result;
		}, () => {
			return null;
		});
	}

	private previousTokenPosition(document: TextDocument, position: Position): Position {
		while (position.character > 0) {
			let word = document.getWordRangeAtPosition(position);
			if (word) {
				return word.start;
			}
			position = position.translate(0, -1);
		}
		return null;
	}

	private walkBackwardsToBeginningOfCall(document: TextDocument, position: Position): { openParen: Position, commas: Position[] } {
		let currentLine = document.lineAt(position.line).text.substring(0, position.character);
		let parenBalance = 0;
		let commas = [];
		for (let char = position.character; char >= 0; char--) {
			switch (currentLine[char]) {
				case '(':
					parenBalance--;
					if (parenBalance < 0) {
						return {
							openParen: new Position(position.line, char),
							commas: commas
						};
					}
					break;
				case ')':
					parenBalance++;
					break;
				case ',':
					if (parenBalance === 0) {
						commas.push(new Position(position.line, char));
					}
			}
		}
		return null;
	}

}
