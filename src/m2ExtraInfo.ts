/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { HoverProvider, Hover, MarkedString, TextDocument, Position, CancellationToken, WorkspaceConfiguration, workspace } from 'vscode';
import { definitionLocation } from './m2Declaration';

export class GoHoverProvider implements HoverProvider {
	private m2Config = null;

	constructor(m2Config?: WorkspaceConfiguration) {
		this.m2Config = m2Config;
		if (!this.m2Config) {
			this.m2Config = vscode.workspace.getConfiguration('m2');
		}
	}

	public provideHover(document: TextDocument, position: Position, token: CancellationToken): Thenable<Hover> {
		let m2Config = this.m2Config;
		// Temporary fix to fall back to godoc if guru is the set docsTool
		if (m2Config['docsTool'] === 'guru') {
			m2Config = Object.assign({}, m2Config, {'docsTool': 'godoc'});
		}
		return definitionLocation(document, position, m2Config, true).then(definitionInfo => {
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
