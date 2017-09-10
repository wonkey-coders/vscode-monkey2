/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import { MONKEY2_FILE_FILTER } from './m2Mode';
import vscode = require('vscode');

export let outputChannel = vscode.window.createOutputChannel('Monkey2');

let statusBarEntry: vscode.StatusBarItem;

export function showHideStatus() {
	if (!statusBarEntry) {
		return;
	}
	if (!vscode.window.activeTextEditor) {
		statusBarEntry.hide();
		return;
	}
	if (vscode.languages.match(MONKEY2_FILE_FILTER, vscode.window.activeTextEditor.document)) {
		statusBarEntry.show();
		return;
	}
	statusBarEntry.hide();
}

export function hideGoStatus() {
	if (statusBarEntry) {
		statusBarEntry.dispose();
	}
}

export function showGoStatus(message: string, command: string, tooltip?: string) {
	statusBarEntry = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MIN_VALUE);
	statusBarEntry.text = message;
	statusBarEntry.command = command;
	statusBarEntry.color = 'yellow';
	statusBarEntry.tooltip = tooltip;
	statusBarEntry.show();
}
