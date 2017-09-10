/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { GoCompletionItemProvider } from './m2Suggest';
import { GoHoverProvider } from './m2ExtraInfo';
import { GoDefinitionProvider } from './m2Declaration';
import { GoReferenceProvider } from './m2References';
import { GoImplementationProvider } from './m2Implementations';
import { GoDocumentFormattingEditProvider, Formatter } from './m2Format';
import { GoRenameProvider } from './m2Rename';
import { GoDocumentSymbolProvider } from './m2Outline';
import { GoRunTestCodeLensProvider } from './m2RunTestCodelens';
import { GoSignatureHelpProvider } from './m2Signature';
import { GoWorkspaceSymbolProvider } from './m2Symbol';
import { GoCodeActionProvider } from './m2CodeAction';
import { check, ICheckResult, removeTestStatus } from './m2Check';
import { updateM2PathM2RootFromConfig, offerToInstallTools } from './m2InstallTools';
import { GO_MODE } from './m2Mode';
import { showHideStatus } from './m2Status';
import { toggleCoverageCurrentPackage, getCodeCoverage, removeCodeCoverage } from './m2Cover';
import { initGoCover } from './m2Cover';
import { testAtCursor, testCurrentPackage, testCurrentFile, testPrevious, testWorkspace } from './m2Test';
import { showTestOutput } from './testUtils';
import * as goGenerateTests from './m2GenerateTests';
import { addImport } from './m2Import';
import { installAllTools, checkLanguageServer } from './m2InstallTools';
import { isMonkey2PathSet, getBinPath, sendTelemetryEvent, getExtensionCommands, getMonkey2Version, getCurrentMonkey2Path } from './util';
import { LanguageClient } from 'vscode-languageclient';
import { clearCacheForTools } from './m2Path';
import { addTags, removeTags } from './m2Modifytags';
import { parseLiveFile } from './m2LiveErrors';
import { GoCodeLensProvider } from './m2Codelens';
import { implCursor } from './m2Impl';
import { goListAll } from './m2Packages';
import { browsePackages } from './m2BrowsePackage';

export let errorDiagnosticCollection: vscode.DiagnosticCollection;
let warningDiagnosticCollection: vscode.DiagnosticCollection;

export function activate(ctx: vscode.ExtensionContext): void {
	let useLangServer = vscode.workspace.getConfiguration('m2')['useLanguageServer'];
	let langServerFlags: string[] = vscode.workspace.getConfiguration('m2')['languageServerFlags'] || [];
	let toolsGopath = vscode.workspace.getConfiguration('m2')['toolsGopath'];

	updateM2PathM2RootFromConfig().then(() => {
		getMonkey2Version().then(currentVersion => {
			if (currentVersion) {
				const prevVersion = ctx.globalState.get('mx2ccVersion');
				const currVersionString = `${currentVersion.major}.${currentVersion.minor}`;

				if (prevVersion !== currVersionString) {
					if (prevVersion) {
						const updateToolsCmdText = 'Update tools';
						vscode.window.showInformationMessage('Your Go version is different than before, few Go tools may need re-compiling', updateToolsCmdText).then(selected => {
							if (selected === updateToolsCmdText) {
								vscode.commands.executeCommand('go.tools.install');
							}
						});
					}
					ctx.globalState.update('mx2ccVersion', currVersionString);
				}
			}
		});
		goListAll();
		offerToInstallTools();
		let langServerAvailable = checkLanguageServer();
		if (langServerAvailable) {
			let langServerFlags: string[] = vscode.workspace.getConfiguration('m2')['languageServerFlags'] || [];
			// Language Server needs M2PATH to be in process.env
			process.env['M2PATH'] = getCurrentMonkey2Path();
			const c = new LanguageClient(
				'go-langserver',
				{
					command: getBinPath('go-langserver'),
					args: ['-mode=stdio', ...langServerFlags],
				},
				{
					documentSelector: ['m2'],
					uriConverters: {
						// Apply file:/// scheme to all file paths.
						code2Protocol: (uri: vscode.Uri): string => (uri.scheme ? uri : uri.with({ scheme: 'file' })).toString(),
						protocol2Code: (uri: string) => vscode.Uri.parse(uri),
					},
				}
			);

			ctx.subscriptions.push(c.start());
		} else {
			ctx.subscriptions.push(vscode.languages.registerHoverProvider(GO_MODE, new GoHoverProvider()));
			ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(GO_MODE, new GoDefinitionProvider()));
			ctx.subscriptions.push(vscode.languages.registerReferenceProvider(GO_MODE, new GoReferenceProvider()));
			ctx.subscriptions.push(vscode.languages.registerImplementationProvider(GO_MODE, new GoImplementationProvider()));
			ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(GO_MODE, new GoDocumentSymbolProvider()));
			ctx.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(new GoWorkspaceSymbolProvider()));
			ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(GO_MODE, new GoSignatureHelpProvider(), '(', ','));
		}

		if (vscode.window.activeTextEditor && isMonkey2PathSet()) {
			runBuilds(vscode.window.activeTextEditor.document, vscode.workspace.getConfiguration('m2'));
		}
	});

	initGoCover(ctx);

	ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(GO_MODE, new GoCompletionItemProvider(), '.', '\"'));
	ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(GO_MODE, new GoDocumentFormattingEditProvider()));
	ctx.subscriptions.push(vscode.languages.registerRenameProvider(GO_MODE, new GoRenameProvider()));
	ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider(GO_MODE, new GoCodeActionProvider()));
	ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(GO_MODE, new GoRunTestCodeLensProvider()));
	ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(GO_MODE, new GoCodeLensProvider()));

	errorDiagnosticCollection = vscode.languages.createDiagnosticCollection('go-error');
	ctx.subscriptions.push(errorDiagnosticCollection);
	warningDiagnosticCollection = vscode.languages.createDiagnosticCollection('go-warning');
	ctx.subscriptions.push(warningDiagnosticCollection);
	vscode.workspace.onDidChangeTextDocument(removeCodeCoverage, null, ctx.subscriptions);
	vscode.workspace.onDidChangeTextDocument(removeTestStatus, null, ctx.subscriptions);
	vscode.window.onDidChangeActiveTextEditor(showHideStatus, null, ctx.subscriptions);
	vscode.window.onDidChangeActiveTextEditor(getCodeCoverage, null, ctx.subscriptions);
	vscode.workspace.onDidChangeTextDocument(parseLiveFile, null, ctx.subscriptions);

	startBuildOnSaveWatcher(ctx.subscriptions);

	ctx.subscriptions.push(vscode.commands.registerCommand('go.gopath', () => {
		let gopath = getCurrentMonkey2Path();
		let wasInfered = vscode.workspace.getConfiguration('m2')['inferGopath'];

		// not only if it was configured, but if it was successful.
		if (wasInfered && vscode.workspace.rootPath.indexOf(gopath) === 0) {
			vscode.window.showInformationMessage('Current M2PATH is inferred from workspace root: ' + gopath);
		} else {
			vscode.window.showInformationMessage('Current M2PATH: ' + gopath);
		}
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.add.tags', (args) => {
		addTags(args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.remove.tags', (args) => {
		removeTags(args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.impl.cursor', () => {
		implCursor();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.cursor', (args) => {
		let goConfig = vscode.workspace.getConfiguration('m2');
		testAtCursor(goConfig, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.package', (args) => {
		let goConfig = vscode.workspace.getConfiguration('m2');
		testCurrentPackage(goConfig, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.file', (args) => {
		let goConfig = vscode.workspace.getConfiguration('m2');
		testCurrentFile(goConfig, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.workspace', (args) => {
		let goConfig = vscode.workspace.getConfiguration('m2');
		testWorkspace(goConfig, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.previous', () => {
		testPrevious();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.coverage', () => {
		toggleCoverageCurrentPackage();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.showOutput', () => {
		showTestOutput();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.import.add', (arg: string) => {
		return addImport(typeof arg === 'string' ? arg : null);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.tools.install', () => {
		installAllTools();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.browse.packages', () => {
		browsePackages();
	}));

	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {
		let updatedGoConfig = vscode.workspace.getConfiguration('m2');
		sendTelemetryEventForConfig(updatedGoConfig);
		updateM2PathM2RootFromConfig();

		// If there was a change in "useLanguageServer" setting, then ask the user to reload VS Code.
		if (process.platform !== 'win32'
			&& didLangServerConfigChange(useLangServer, langServerFlags, updatedGoConfig)
			&& (!updatedGoConfig['useLanguageServer'] || checkLanguageServer())) {
			vscode.window.showInformationMessage('Reload VS Code window for the change in usage of language server to take effect', 'Reload').then(selected => {
				if (selected === 'Reload') {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			});
		}
		useLangServer = updatedGoConfig['useLanguageServer'];

		// If there was a change in "toolsGopath" setting, then clear cache for go tools
		if (toolsGopath !== updatedGoConfig['toolsGopath']) {
			clearCacheForTools();
			toolsGopath = updatedGoConfig['toolsGopath'];
		}

	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.generate.package', () => {
		goGenerateTests.generateTestCurrentPackage();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.generate.file', () => {
		goGenerateTests.generateTestCurrentFile();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.test.generate.function', () => {
		goGenerateTests.generateTestCurrentFunction();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.toggle.test.file', () => {
		goGenerateTests.toggleTestFile();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.debug.startSession', config => {
		if (!config.request) { // if 'request' is missing interpret this as a missing launch.json
			let activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor || activeEditor.document.languageId !== 'm2') {
				return;
			}

			config = Object.assign(config, {
				'name': 'Launch',
				'type': 'm2',
				'request': 'launch',
				'mode': 'debug',
				'program': activeEditor.document.fileName,
				'env': {
					'M2PATH': getCurrentMonkey2Path()
				}
			});
		}
		vscode.commands.executeCommand('vscode.startDebug', config);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('go.show.commands', () => {
		vscode.window.showQuickPick(getExtensionCommands().map(x => x.title)).then(cmd => {
			let selectedCmd = getExtensionCommands().find(x => x.title === cmd);
			if (selectedCmd) {
				vscode.commands.executeCommand(selectedCmd.command);
			}
		});
	}));

	vscode.languages.setLanguageConfiguration(GO_MODE.language, {
		indentationRules: {
			decreaseIndentPattern: /^\s*(\bcase\b.*:|\bdefault\b:|}[),]?|\)[,]?)$/,
			increaseIndentPattern: /^.*(\bcase\b.*:|\bdefault\b:|(\b(func|if|else|switch|select|for|struct)\b.*)?{[^}]*|\([^)]*)$/
		},
		wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
	});

	sendTelemetryEventForConfig(vscode.workspace.getConfiguration('m2'));
}

function deactivate() {
}

function runBuilds(document: vscode.TextDocument, goConfig: vscode.WorkspaceConfiguration) {

	function mapSeverityToVSCodeSeverity(sev: string) {
		switch (sev) {
			case 'error': return vscode.DiagnosticSeverity.Error;
			case 'warning': return vscode.DiagnosticSeverity.Warning;
			default: return vscode.DiagnosticSeverity.Error;
		}
	}

	if (document.languageId !== 'm2') {
		return;
	}

	let uri = document.uri;
	check(uri.fsPath, goConfig).then(errors => {
		errorDiagnosticCollection.clear();
		warningDiagnosticCollection.clear();

		let diagnosticMap: Map<string, Map<vscode.DiagnosticSeverity, vscode.Diagnostic[]>> = new Map();

		errors.forEach(error => {
			let canonicalFile = vscode.Uri.file(error.file).toString();
			let startColumn = 0;
			let endColumn = 1;
			if (document && document.uri.toString() === canonicalFile) {
				let range = new vscode.Range(error.line - 1, 0, error.line - 1, document.lineAt(error.line - 1).range.end.character + 1);
				let text = document.getText(range);
				let [_, leading, trailing] = /^(\s*).*(\s*)$/.exec(text);
				startColumn = leading.length;
				endColumn = text.length - trailing.length;
			}
			let range = new vscode.Range(error.line - 1, startColumn, error.line - 1, endColumn);
			let severity = mapSeverityToVSCodeSeverity(error.severity);
			let diagnostic = new vscode.Diagnostic(range, error.msg, severity);
			let diagnostics = diagnosticMap.get(canonicalFile);
			if (!diagnostics) {
				diagnostics = new Map<vscode.DiagnosticSeverity, vscode.Diagnostic[]>();
			}
			if (!diagnostics[severity]) {
				diagnostics[severity] = [];
			}
			diagnostics[severity].push(diagnostic);
			diagnosticMap.set(canonicalFile, diagnostics);
		});
		diagnosticMap.forEach((diagMap, file) => {
			errorDiagnosticCollection.set(vscode.Uri.parse(file), diagMap[vscode.DiagnosticSeverity.Error]);
			warningDiagnosticCollection.set(vscode.Uri.parse(file), diagMap[vscode.DiagnosticSeverity.Warning]);
		});
	}).catch(err => {
		vscode.window.showInformationMessage('Error: ' + err);
	});
}

function startBuildOnSaveWatcher(subscriptions: vscode.Disposable[]) {

	// TODO: This is really ugly.  I'm not sure we can do better until
	// Code supports a pre-save event where we can do the formatting before
	// the file is written to disk.
	let ignoreNextSave = new WeakSet<vscode.TextDocument>();

	vscode.workspace.onDidSaveTextDocument(document => {
		if (document.languageId !== 'm2' || ignoreNextSave.has(document)) {
			return;
		}
		let goConfig = vscode.workspace.getConfiguration('m2');
		let textEditor = vscode.window.activeTextEditor;
		let formatPromise: PromiseLike<void> = Promise.resolve();
		if (goConfig['formatOnSave'] && textEditor.document === document) {
			let formatter = new Formatter();
			formatPromise = formatter.formatDocument(document).then(edits => {
				let workspaceEdit = new vscode.WorkspaceEdit();
				workspaceEdit.set(document.uri, edits);
				return vscode.workspace.applyEdit(workspaceEdit);

			}).then(applied => {
				ignoreNextSave.add(document);
				return document.save();
			}).then(() => {
				ignoreNextSave.delete(document);
			}, () => {
				// Catch any errors and ignore so that we still trigger
				// the file save.
			});
		}
		formatPromise.then(() => {
			runBuilds(document, goConfig);
		});
	}, null, subscriptions);

}

function sendTelemetryEventForConfig(goConfig: vscode.WorkspaceConfiguration) {
	sendTelemetryEvent('goConfig', {
		buildOnSave: goConfig['buildOnSave'] + '',
		buildFlags: goConfig['buildFlags'],
		buildTags: goConfig['buildTags'],
		formatOnSave: goConfig['formatOnSave'] + '',
		formatTool: goConfig['formatTool'],
		formatFlags: goConfig['formatFlags'],
		lintOnSave: goConfig['lintOnSave'] + '',
		lintFlags: goConfig['lintFlags'],
		lintTool: goConfig['lintTool'],
		vetOnSave: goConfig['vetOnSave'] + '',
		vetFlags: goConfig['vetFlags'],
		testOnSave: goConfig['testOnSave'] + '',
		testFlags: goConfig['testFlags'],
		coverOnSave: goConfig['coverOnSave'] + '',
		coverOnTestPackage: goConfig['coverOnTestPackage'] + '',
		coverageDecorator: goConfig['coverageDecorator'],
		coverageOptions: goConfig['coverageOptions'],
		useDiffForFormatting: goConfig['useDiffForFormatting'] + '',
		gopath: goConfig['gopath'] ? 'set' : '',
		goroot: goConfig['goroot'] ? 'set' : '',
		inferGopath: goConfig['inferGopath'] + '',
		toolsGopath: goConfig['toolsGopath'] ? 'set' : '',
		gocodeAutoBuild: goConfig['gocodeAutoBuild'] + '',
		useCodeSnippetsOnFunctionSuggest: goConfig['useCodeSnippetsOnFunctionSuggest'] + '',
		autocompleteUnimportedPackages: goConfig['autocompleteUnimportedPackages'] + '',
		docsTool: goConfig['docsTool'],
		useLanguageServer: goConfig['useLanguageServer'] + '',
		includeImports: goConfig['gotoSymbol'] && goConfig['gotoSymbol']['includeImports'] + '',
		addTags: JSON.stringify(goConfig['addTags']),
		removeTags: JSON.stringify(goConfig['removeTags']),
		editorContextMenuCommands: JSON.stringify(goConfig['editorContextMenuCommands']),
		liveErrors: JSON.stringify(goConfig['liveErrors']),
		codeLens: JSON.stringify(goConfig['enableCodeLens'])
	});
}

function didLangServerConfigChange(useLangServer: boolean, langServerFlags: string[], newconfig: vscode.WorkspaceConfiguration) {
	let newLangServerFlags = newconfig['languageServerFlags'] || [];
	if (useLangServer !== newconfig['useLanguageServer'] || langServerFlags.length !== newLangServerFlags.length) {
		return true;
	}

	for (let i = 0; i < langServerFlags.length; i++) {
		if (newLangServerFlags[i] !== langServerFlags[i]) {
			return true;
		}
	}
	return false;
}