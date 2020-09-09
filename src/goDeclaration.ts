/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import cp = require('child_process');
import path = require('path');
import vscode = require('vscode');
import { toolExecutionEnvironment } from './goEnv';
import { promptForMissingTool, promptForUpdatingTool } from './goInstallTools';
import { getModFolderPath, promptToUpdateToolForModules } from './goModules';
import {
	byteOffsetAt,
	getBinPath,
	getFileArchive,
	getGoConfig,
	getModuleCache,
	getWorkspaceFolderPath,
	goKeywords,
	isPositionInString,
	runGodoc
} from './util';
import { getCurrentGoRoot } from './utils/goPath';
import { killProcessTree } from './utils/processUtils';

const missingToolMsg = 'Missing tool: ';

// info regarding where the definition is at 
export interface GoDefinitionInformation {
	file: string;
	line: number;
	column: number;
	doc: string;
	declarationlines: string[];
	name: string;
	toolUsed: string;
}

// input to the "Go to definition"
interface GoDefinitionInput {
	document: vscode.TextDocument;
	position: vscode.Position;
	word: string;
	includeDocs: boolean;
	isMod: boolean;
	cwd: string;
}

interface GoGetDocOuput {
	name: string;
	import: string;
	decl: string;
	doc: string;
	pos: string;
}

interface GuruDefinitionOuput {
	objpos: string;
	desc: string;
}

export function definitionLocation(
	document: vscode.TextDocument,
	position: vscode.Position,
	goConfig: vscode.WorkspaceConfiguration,
	includeDocs: boolean,
	token: vscode.CancellationToken
): Promise<GoDefinitionInformation> {
	const adjustedPos = adjustWordPosition(document, position);
	// if adjustedPos[0] === false, meaning wordRange is not found
	if (!adjustedPos[0]) {
		// Promise.resolve() method returns a Promise object that is resolved with a given value (ie. null)
		/*
		Promise.resolve('Success').then(function(value) {
  			console.log(value); // "Success"
		}, function(value) {
  			// not called
		});*/
		return Promise.resolve(null);
	}
	// the text of a word
	const word = adjustedPos[1];
	// the position where the 'Go to Definition' is intiated
	// usually equals to the cursor position
	position = adjustedPos[2];

	if (!goConfig) {
		// get the Go configs relating to the current document
		goConfig = getGoConfig(document.uri);
	}
	// we need to know what tool is being used to generate Go docs
	// Godoc or Gogetdoc or Guru
	const toolForDocs = goConfig['docsTool'] || 'godoc';
	// get module folder path?
	return getModFolderPath(document.uri).then((modFolderPath) => {
		const input: GoDefinitionInput = {
			document,
			position,
			word,
			includeDocs,
			isMod: !!modFolderPath,
			cwd:
				modFolderPath && modFolderPath !== getModuleCache()
					? modFolderPath
					: getWorkspaceFolderPath(document.uri) || path.dirname(document.fileName)
		};
		if (toolForDocs === 'godoc') {
			return definitionLocation_godef(input, token);
		} else if (toolForDocs === 'guru') {
			return definitionLocation_guru(input, token);
		}
		return definitionLocation_gogetdoc(input, token, true);
	});
}

export function adjustWordPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): [boolean, string, vscode.Position] {
	// getWordRangeAtPosition() gets the range of the word
	const wordRange = document.getWordRangeAtPosition(position);
	// get the text of the line where the word is at
	const lineText = document.lineAt(position.line).text;
	// get the text of the word
	const word = wordRange ? document.getText(wordRange) : '';
	if (
		!wordRange ||
		// here we need to decide if the line is a comment
		// that's why we need to obtain the lineText
		lineText.startsWith('//') ||
		isPositionInString(document, position) ||
		word.match(/^\d+.?\d+$/) ||
		// if the word is amongst the Go keywords
		goKeywords.indexOf(word) > 0
	) {
		return [false, null, null];
	}
	// if current cursor is at the end of the word and is after the start of the word
	// move the cursor to the left one character
	if (position.isEqual(wordRange.end) && position.isAfter(wordRange.start)) {
		position = position.translate(0, -1);
	}

	return [true, word, position];
}
// Go import pattern
// import (
//     . "math"
//     "fmt"
// )
const godefImportDefinitionRegex = /^import \(.* ".*"\)$/;
function definitionLocation_godef(
	input: GoDefinitionInput,
	token: vscode.CancellationToken,
	useReceivers: boolean = true
): Promise<GoDefinitionInformation> {
	const godefTool = 'godef';
	const godefPath = getBinPath(godefTool);
	if (!path.isAbsolute(godefPath)) {
		return Promise.reject(missingToolMsg + godefTool);
	}
	// the offset of position in document
	const offset = byteOffsetAt(input.document, input.position);
	const env = toolExecutionEnvironment();
	env['GOROOT'] = getCurrentGoRoot();
	let p: cp.ChildProcess;
	// pass this token part first
	// used to kill child process
	if (token) {
		token.onCancellationRequested(() => killProcessTree(p));
	}

	return new Promise<GoDefinitionInformation>((resolve, reject) => {
		// Spawn `godef` process
		const args = ['-t', '-i', '-f', input.document.fileName, '-o', offset.toString()];
		// if (useReceivers) {
		// 	args.push('-r');
		// }
		p = cp.execFile(godefPath, args, { env, cwd: input.cwd }, (err, stdout, stderr) => {
			try {
				if (err && (<any>err).code === 'ENOENT') {
					return reject(missingToolMsg + godefTool);
				}
				if (err) {
					if (
						input.isMod &&
						!input.includeDocs &&
						stderr &&
						stderr.startsWith(`godef: no declaration found for`)
					) {
						promptToUpdateToolForModules(
							'godef',
							`To get the Go to Definition feature when using Go modules, please update your version of the "godef" tool.`
						);
						return reject(stderr);
					}
					if (stderr.indexOf('flag provided but not defined: -r') !== -1) {
						promptForUpdatingTool('godef');
						p = null;
						return definitionLocation_godef(input, token, false).then(resolve, reject);
					}
					return reject(err.message || stderr);
				}
				const result = stdout.toString();
				const lines = result.split('\n');
				// lines[0] = "/Users/jiaming/Documents/gitrepos/fzf/src/ansi.go:64:6"
				let match = /(.*):(\d+):(\d+)/.exec(lines[0]);
				// if no match, meaning the defintioin is not found in any file
				if (!match) {
					// TODO: Gotodef on pkg name:
					// /usr/local/go/src/html/template\n
					return resolve(null);
				}
				// _ is the whole string
				// [
				//	"/Users/jiaming/Documents/gitrepos/fzf/src/ansi.go:64:6",
				//	"/Users/jiaming/Documents/gitrepos/fzf/src/ansi.go",
				//	"64",
				// 	"6"
				// 	]
				const [_, file, line, col] = match;
				// path is a library
				// pkgPath = "/Users/jiaming/Documents/gitrepos/fzf/src"
				const pkgPath = path.dirname(file);
				const definitionInformation: GoDefinitionInformation = {
					file,
					line: +line - 1,
					column: +col - 1,
					// "toAnsiString func(color Color, offset int) string"
					declarationlines: lines.slice(1),
					toolUsed: 'godef',
					doc: null,
					name: null
				};
				// includeDocs is false or declaration line match the import regex
				// if we don't need to include documentation in the result, we will just return the result w/o doc
				if (!input.includeDocs || godefImportDefinitionRegex.test(definitionInformation.declarationlines[0])) {
					return resolve(definitionInformation);
				}
				// if includeDocs is true
				match = /^\w+ \(\*?(\w+)\)/.exec(lines[1]);
				runGodoc(input.cwd, pkgPath, match ? match[1] : '', input.word, token)
					.then((doc) => {
						if (doc) {
							definitionInformation.doc = doc;
						}
						resolve(definitionInformation);
					})
					.catch((runGoDocErr) => {
						console.log(runGoDocErr);
						resolve(definitionInformation);
					});
			} catch (e) {
				reject(e);
			}
		});
		if (p.pid) {
			p.stdin.end(input.document.getText());
		}
	});
}

function definitionLocation_gogetdoc(
	input: GoDefinitionInput,
	token: vscode.CancellationToken,
	useTags: boolean
): Promise<GoDefinitionInformation> {
	const gogetdoc = getBinPath('gogetdoc');
	if (!path.isAbsolute(gogetdoc)) {
		return Promise.reject(missingToolMsg + 'gogetdoc');
	}
	const offset = byteOffsetAt(input.document, input.position);
	const env = toolExecutionEnvironment();
	let p: cp.ChildProcess;
	if (token) {
		token.onCancellationRequested(() => killProcessTree(p));
	}

	return new Promise<GoDefinitionInformation>((resolve, reject) => {
		const gogetdocFlagsWithoutTags = [
			'-u',
			'-json',
			'-modified',
			'-pos',
			input.document.fileName + ':#' + offset.toString()
		];
		const buildTags = getGoConfig(input.document.uri)['buildTags'];
		const gogetdocFlags =
			buildTags && useTags ? [...gogetdocFlagsWithoutTags, '-tags', buildTags] : gogetdocFlagsWithoutTags;
		p = cp.execFile(gogetdoc, gogetdocFlags, { env, cwd: input.cwd }, (err, stdout, stderr) => {
			try {
				if (err && (<any>err).code === 'ENOENT') {
					return reject(missingToolMsg + 'gogetdoc');
				}
				if (stderr && stderr.startsWith('flag provided but not defined: -tags')) {
					p = null;
					return definitionLocation_gogetdoc(input, token, false).then(resolve, reject);
				}
				if (err) {
					if (input.isMod && !input.includeDocs && stdout.startsWith(`gogetdoc: couldn't get package for`)) {
						promptToUpdateToolForModules(
							'gogetdoc',
							`To get the Go to Definition feature when using Go modules, please update your version of the "gogetdoc" tool.`
						);
						return resolve(null);
					}
					return reject(err.message || stderr);
				}
				const goGetDocOutput = <GoGetDocOuput>JSON.parse(stdout.toString());
				const match = /(.*):(\d+):(\d+)/.exec(goGetDocOutput.pos);
				const definitionInfo: GoDefinitionInformation = {
					file: null,
					line: 0,
					column: 0,
					toolUsed: 'gogetdoc',
					declarationlines: goGetDocOutput.decl.split('\n'),
					doc: goGetDocOutput.doc,
					name: goGetDocOutput.name
				};
				if (!match) {
					return resolve(definitionInfo);
				}
				const [_, file, line, col] = match;
				definitionInfo.file = match[1];
				definitionInfo.line = +match[2] - 1;
				definitionInfo.column = +match[3] - 1;
				return resolve(definitionInfo);
			} catch (e) {
				reject(e);
			}
		});
		if (p.pid) {
			p.stdin.end(getFileArchive(input.document));
		}
	});
}

function definitionLocation_guru(
	input: GoDefinitionInput,
	token: vscode.CancellationToken
): Promise<GoDefinitionInformation> {
	const guru = getBinPath('guru');
	if (!path.isAbsolute(guru)) {
		return Promise.reject(missingToolMsg + 'guru');
	}
	const offset = byteOffsetAt(input.document, input.position);
	const env = toolExecutionEnvironment();
	let p: cp.ChildProcess;
	if (token) {
		token.onCancellationRequested(() => killProcessTree(p));
	}
	return new Promise<GoDefinitionInformation>((resolve, reject) => {
		p = cp.execFile(
			guru,
			['-json', '-modified', 'definition', input.document.fileName + ':#' + offset.toString()],
			{ env },
			(err, stdout, stderr) => {
				try {
					if (err && (<any>err).code === 'ENOENT') {
						return reject(missingToolMsg + 'guru');
					}
					if (err) {
						return reject(err.message || stderr);
					}
					const guruOutput = <GuruDefinitionOuput>JSON.parse(stdout.toString());
					const match = /(.*):(\d+):(\d+)/.exec(guruOutput.objpos);
					const definitionInfo: GoDefinitionInformation = {
						file: null,
						line: 0,
						column: 0,
						toolUsed: 'guru',
						declarationlines: [guruOutput.desc],
						doc: null,
						name: null
					};
					if (!match) {
						return resolve(definitionInfo);
					}
					const [_, file, line, col] = match;
					definitionInfo.file = match[1];
					definitionInfo.line = +match[2] - 1;
					definitionInfo.column = +match[3] - 1;
					return resolve(definitionInfo);
				} catch (e) {
					reject(e);
				}
			}
		);
		if (p.pid) {
			p.stdin.end(getFileArchive(input.document));
		}
	});
}

export function parseMissingError(err: any): [boolean, string] {
	if (err) {
		// Prompt for missing tool is located here so that the
		// prompts dont show up on hover or signature help
		if (typeof err === 'string' && err.startsWith(missingToolMsg)) {
			return [true, err.substr(missingToolMsg.length)];
		}
	}
	return [false, null];
}
// DefinitionProvider is an interface
export class GoDefinitionProvider implements vscode.DefinitionProvider {
	private goConfig: vscode.WorkspaceConfiguration = null;

	constructor(goConfig?: vscode.WorkspaceConfiguration) {
		this.goConfig = goConfig;
	}
	// provideDefinition returns 
	public provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Thenable<vscode.Location> {
		// definitionLocation() returns 'definitionInformation' in definitionLocation_godef()
		// definitionInformation is of type of GoDefinitionInformation interface
		return definitionLocation(document, position, this.goConfig, false, token).then(
			(definitionInfo) => {
				if (definitionInfo == null || definitionInfo.file == null) {
					return null;
				}
				// Uri.file returns a Uri
				const definitionResource = vscode.Uri.file(definitionInfo.file);
				const pos = new vscode.Position(definitionInfo.line, definitionInfo.column);
				return new vscode.Location(definitionResource, pos);
			},
			(err) => {
				const miss = parseMissingError(err);
				if (miss[0]) {
					promptForMissingTool(miss[1]);
				} else if (err) {
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			}
		);
	}
}
