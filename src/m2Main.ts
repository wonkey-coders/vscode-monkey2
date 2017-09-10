/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { GoCompletionItemProvider } from './m2Suggest';
import { GoHoverProvider } from './m2ExtraInfo';
import { Monkey2DefinitionProvider } from './m2Declaration';
import { GoReferenceProvider } from './m2References';
import { Monkey2ImplementationProvider } from './m2Implementations';
import { Monkey2DocumentFormattingEditProvider, Formatter } from './m2Format';
import { GoRenameProvider } from './m2Rename';
import { GoDocumentSymbolProvider } from './m2Outline';
import { GoRunTestCodeLensProvider } from './m2RunTestCodelens';
import { GoSignatureHelpProvider } from './m2Signature';
import { GoWorkspaceSymbolProvider } from './m2Symbol';
import { GoCodeActionProvider } from './m2CodeAction';
import { check, ICheckResult, removeTestStatus } from './m2Check';
import { updateM2PathM2RootFromConfig, offerToInstallTools } from './m2InstallTools';
import { MONKEY2_FILE_FILTER } from './m2Mode';
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
import { monkey2ListModules } from './m2Packages';
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
								vscode.commands.executeCommand('m2.tools.install');
							}
						});
					}
					ctx.globalState.update('mx2ccVersion', currVersionString);
				}
			}
		});
		monkey2ListModules();
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
			ctx.subscriptions.push(vscode.languages.registerHoverProvider(MONKEY2_FILE_FILTER, new GoHoverProvider()));
			ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(MONKEY2_FILE_FILTER, new Monkey2DefinitionProvider()));
			ctx.subscriptions.push(vscode.languages.registerReferenceProvider(MONKEY2_FILE_FILTER, new GoReferenceProvider()));
			ctx.subscriptions.push(vscode.languages.registerImplementationProvider(MONKEY2_FILE_FILTER, new Monkey2ImplementationProvider()));
			ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(MONKEY2_FILE_FILTER, new GoDocumentSymbolProvider()));
			ctx.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(new GoWorkspaceSymbolProvider()));
			ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(MONKEY2_FILE_FILTER, new GoSignatureHelpProvider(), '(', ','));
		}

		if (vscode.window.activeTextEditor && isMonkey2PathSet()) {
			runBuilds(vscode.window.activeTextEditor.document, vscode.workspace.getConfiguration('m2'));
		}
	});

	initGoCover(ctx);

//	ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(MONKEY2_FILE_FILTER, new GoCompletionItemProvider(), '.', '\"'));
	ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(MONKEY2_FILE_FILTER, new Monkey2DocumentFormattingEditProvider()));
	ctx.subscriptions.push(vscode.languages.registerRenameProvider(MONKEY2_FILE_FILTER, new GoRenameProvider()));
	ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider(MONKEY2_FILE_FILTER, new GoCodeActionProvider()));
	ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(MONKEY2_FILE_FILTER, new GoRunTestCodeLensProvider()));
	ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(MONKEY2_FILE_FILTER, new GoCodeLensProvider()));

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

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.gopath', () => {
		let gopath = getCurrentMonkey2Path();
		let wasInfered = vscode.workspace.getConfiguration('m2')['inferPath'];

		// not only if it was configured, but if it was successful.
		if (wasInfered && vscode.workspace.rootPath.indexOf(gopath) === 0) {
			vscode.window.showInformationMessage('Current M2PATH is inferred from workspace root: ' + gopath);
		} else {
			vscode.window.showInformationMessage('Current M2PATH: ' + gopath);
		}
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.add.tags', (args) => {
		addTags(args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.remove.tags', (args) => {
		removeTags(args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.impl.cursor', () => {
		implCursor();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.cursor', (args) => {
		let m2Config = vscode.workspace.getConfiguration('m2');
		testAtCursor(m2Config, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.package', (args) => {
		let m2Config = vscode.workspace.getConfiguration('m2');
		testCurrentPackage(m2Config, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.file', (args) => {
		let m2Config = vscode.workspace.getConfiguration('m2');
		testCurrentFile(m2Config, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.workspace', (args) => {
		let m2Config = vscode.workspace.getConfiguration('m2');
		testWorkspace(m2Config, args);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.previous', () => {
		testPrevious();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.coverage', () => {
		toggleCoverageCurrentPackage();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.showOutput', () => {
		showTestOutput();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.import.add', (arg: string) => {
		return addImport(typeof arg === 'string' ? arg : null);
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.tools.install', () => {
		installAllTools();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.browse.packages', () => {
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

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.generate.package', () => {
		goGenerateTests.generateTestCurrentPackage();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.generate.file', () => {
		goGenerateTests.generateTestCurrentFile();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.test.generate.function', () => {
		goGenerateTests.generateTestCurrentFunction();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.toggle.test.file', () => {
		goGenerateTests.toggleTestFile();
	}));

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.debug.startSession', config => {
		if (!config.request) { // if 'request' is missing interpret this as a missing launch.json
			let activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor || activeEditor.document.languageId !== 'monkey2') {
				return;
			}

			config = Object.assign(config, {
				'name': 'Launch',
				'type': 'monkey2',
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

	ctx.subscriptions.push(vscode.commands.registerCommand('m2.show.commands', () => {
		vscode.window.showQuickPick(getExtensionCommands().map(x => x.title)).then(cmd => {
			let selectedCmd = getExtensionCommands().find(x => x.title === cmd);
			if (selectedCmd) {
				vscode.commands.executeCommand(selectedCmd.command);
			}
		});
	}));

	vscode.languages.setLanguageConfiguration(MONKEY2_FILE_FILTER.language, {
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

function runBuilds(document: vscode.TextDocument, m2Config: vscode.WorkspaceConfiguration) {

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
	check(uri.fsPath, m2Config).then(errors => {
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
		let m2Config = vscode.workspace.getConfiguration('m2');
		let textEditor = vscode.window.activeTextEditor;
		let formatPromise: PromiseLike<void> = Promise.resolve();
		if (m2Config['formatOnSave'] && textEditor.document === document) {
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
			runBuilds(document, m2Config);
		});
	}, null, subscriptions);

}

function sendTelemetryEventForConfig(m2Config: vscode.WorkspaceConfiguration) {
	sendTelemetryEvent('m2Config', {
		buildOnSave: m2Config['buildOnSave'] + '',
		buildFlags: m2Config['buildFlags'],
		buildTags: m2Config['buildTags'],
		formatOnSave: m2Config['formatOnSave'] + '',
		formatTool: m2Config['formatTool'],
		formatFlags: m2Config['formatFlags'],
		lintOnSave: m2Config['lintOnSave'] + '',
		lintFlags: m2Config['lintFlags'],
		lintTool: m2Config['lintTool'],
		vetOnSave: m2Config['vetOnSave'] + '',
		vetFlags: m2Config['vetFlags'],
		testOnSave: m2Config['testOnSave'] + '',
		testFlags: m2Config['testFlags'],
		coverOnSave: m2Config['coverOnSave'] + '',
		coverOnTestPackage: m2Config['coverOnTestPackage'] + '',
		coverageDecorator: m2Config['coverageDecorator'],
		coverageOptions: m2Config['coverageOptions'],
		useDiffForFormatting: m2Config['useDiffForFormatting'] + '',
		m2path: m2Config['path'] ? 'set' : '',
		m2root: m2Config['root'] ? 'set' : '',
		inferPath: m2Config['inferPath'] + '',
		toolsGopath: m2Config['toolsGopath'] ? 'set' : '',
		gocodeAutoBuild: m2Config['gocodeAutoBuild'] + '',
		useCodeSnippetsOnFunctionSuggest: m2Config['useCodeSnippetsOnFunctionSuggest'] + '',
		autocompleteUnimportedPackages: m2Config['autocompleteUnimportedPackages'] + '',
		docsTool: m2Config['docsTool'],
		useLanguageServer: m2Config['useLanguageServer'] + '',
		includeImports: m2Config['gotoSymbol'] && m2Config['gotoSymbol']['includeImports'] + '',
		addTags: JSON.stringify(m2Config['addTags']),
		removeTags: JSON.stringify(m2Config['removeTags']),
		editorContextMenuCommands: JSON.stringify(m2Config['editorContextMenuCommands']),
		liveErrors: JSON.stringify(m2Config['liveErrors']),
		codeLens: JSON.stringify(m2Config['enableCodeLens'])
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