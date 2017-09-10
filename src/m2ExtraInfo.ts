/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { HoverProvider, Hover, MarkedString, TextDocument, Position, CancellationToken, WorkspaceConfiguration, workspace } from 'vscode';
import { definitionLocation } from './m2Declaration';

export class GoHoverProvider implements HoverProvider {
	private goConfig = null;

	constructor(goConfig?: WorkspaceConfiguration) {
		this.goConfig = goConfig;
		if (!this.goConfig) {
			this.goConfig = vscode.workspace.getConfiguration('m2');
		}
	}

	public provideHover(document: TextDocument, position: Position, token: CancellationToken): Thenable<Hover> {
		let goConfig = this.goConfig;
		// Temporary fix to fall back to godoc if guru is the set docsTool
		if (goConfig['docsTool'] === 'guru') {
			goConfig = Object.assign({}, goConfig, {'docsTool': 'godoc'});
		}
		return definitionLocation(document, position, goConfig, true).then(definitionInfo => {
			if (definitionInfo == null) return null;
			let lines = definitionInfo.declarationlines
				.filter(line => !line.startsWith('\t//') && line !== '')
				.map(line => line.replace(/\t/g, '    '));
			let text;
			text = lines.join('\n').replace(/\n+$/, '');
			let hoverTexts: MarkedString[] = [];
			hoverTexts.push({ language: 'm2', value: text });
			if (definitionInfo.doc != null) {
				hoverTexts.push(definitionInfo.doc);
			}
			let hover = new Hover(hoverTexts);
			return hover;
		}, () => {
			return null;
		});
	}
}
