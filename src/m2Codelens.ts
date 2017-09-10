'use strict';

import vscode = require('vscode');
import { CodeLensProvider, SymbolInformation, SymbolKind, TextDocument, CancellationToken, CodeLens, Range, Command, Location, commands } from 'vscode';
import { documentSymbols, GoDocumentSymbolProvider } from './m2Outline';
import { GoReferenceProvider } from './m2References';

const methodRegex = /^func\s+\(\s*\w+\s+\*?\w+\s*\)\s+/;

class ReferencesCodeLens extends CodeLens {
	constructor(
		public document: TextDocument,
		public symbol: SymbolInformation,
		range: Range
	) {
		super(range);
	}
}

export class Monkey2LensProvider implements CodeLensProvider {
	public provideCodeLenses(document: TextDocument, token: CancellationToken): CodeLens[] | Thenable<CodeLens[]> {
		let codeLensConfig = vscode.workspace.getConfiguration('monkey2').get('enableCodeLens');
		let codelensEnabled = codeLensConfig ? codeLensConfig['references'] : false;
		if (!codelensEnabled) {
			return Promise.resolve([]);
		}

		return this.provideDocumentSymbols(document, token).then(symbols => {
			return symbols.map(symbol => {
				let position = symbol.location.range.start;

				// Add offset for functions as go-outline returns position at the keyword func instead of func name
				if (symbol.kind === vscode.SymbolKind.Function) {
					let funcDecl = document.lineAt(position.line).text.substr(position.character);
					let match = methodRegex.exec(funcDecl);
					position = position.translate(0, match ? match[0].length : 5);
				}
				return new ReferencesCodeLens(document, symbol, new vscode.Range(position, position));
			});
		});
	}

	public resolveCodeLens?(inputCodeLens: CodeLens, token: CancellationToken): CodeLens | Thenable<CodeLens> {
		let codeLens = inputCodeLens as ReferencesCodeLens;

		if (token.isCancellationRequested) {
			return Promise.resolve(codeLens);
		}

		let options = {
			includeDeclaration: false
		};
		let referenceProvider = new GoReferenceProvider();
		return referenceProvider.provideReferences(codeLens.document, codeLens.range.start, options, token).then(references => {
			if (references) {
				codeLens.command = {
					title: references.length === 1
						? '1 reference'
						: references.length + ' references',
					command: 'editor.action.showReferences',
					arguments: [codeLens.document.uri, codeLens.range.start, references]
				};
			} else {
				codeLens.command = {
					title: 'No references found',
					command: ''
				};
			}
			return codeLens;
		});
	}

	private provideDocumentSymbols(document: TextDocument, token: CancellationToken): Thenable<vscode.SymbolInformation[]> {
		let symbolProvider = new GoDocumentSymbolProvider();
		let isTestFile = document.fileName.endsWith('_test.go');
		return symbolProvider.provideDocumentSymbols(document, token).then(symbols => {
			return symbols.filter(symbol => {

				if (symbol.kind === vscode.SymbolKind.Interface) {
					return true;
				}

				if (symbol.kind === vscode.SymbolKind.Function) {
					if (isTestFile && (symbol.name.startsWith('Test') || symbol.name.startsWith('Example') || symbol.name.startsWith('Benchmark'))) {
						return false;
					}
					return true;
				}

				return false;
			}
			);
		});
	}
}