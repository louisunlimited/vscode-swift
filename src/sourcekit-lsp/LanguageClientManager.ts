//===----------------------------------------------------------------------===//
//
// This source file is part of the VS Code Swift open source project
//
// Copyright (c) 2021-2024 the VS Code Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VS Code Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as path from "path";
import {
    CloseAction,
    CloseHandlerResult,
    DidChangeWorkspaceFoldersNotification,
    DocumentSelector,
    ErrorAction,
    ErrorHandler,
    ErrorHandlerResult,
    LanguageClientOptions,
    Message,
    MessageType,
    RevealOutputChannelOn,
    State,
    vsdiag,
} from "vscode-languageclient";
import configuration from "../configuration";
import { swiftRuntimeEnv } from "../utilities/utilities";
import { isPathInsidePath } from "../utilities/filesystem";
import { Version } from "../utilities/version";
import { FolderOperation, WorkspaceContext } from "../WorkspaceContext";
import { activateLegacyInlayHints } from "./inlayHints";
import { activatePeekDocuments } from "./peekDocuments";
import { FolderContext } from "../FolderContext";
import { Executable, LanguageClient, ServerOptions } from "vscode-languageclient/node";
import { ArgumentFilter, BuildFlags } from "../toolchain/BuildFlags";
import { DiagnosticsManager } from "../DiagnosticsManager";
import { LSPLogger, LSPOutputChannel } from "./LSPOutputChannel";
import { SwiftOutputChannel } from "../ui/SwiftOutputChannel";
import { promptForDiagnostics } from "../commands/captureDiagnostics";
import { activateGetReferenceDocument } from "./getReferenceDocument";
import { uriConverters } from "./uriConverters";
import { LanguageClientFactory } from "./LanguageClientFactory";
import { SourceKitLogMessageNotification, SourceKitLogMessageParams } from "./extensions";
import { LSPActiveDocumentManager } from "./didChangeActiveDocument";
import { DidChangeActiveDocumentNotification } from "./extensions/DidChangeActiveDocumentRequest";

/**
 * Manages the creation and destruction of Language clients as we move between
 * workspace folders
 */
export class LanguageClientManager implements vscode.Disposable {
    // known log names
    static indexingLogName = "SourceKit-LSP: Indexing";

    // document selector used by language client
    static appleLangDocumentSelector: SourceKitDocumentSelector = [
        { scheme: "sourcekit-lsp", language: "swift" },
        { scheme: "file", language: "swift" },
        { scheme: "untitled", language: "swift" },
        { scheme: "file", language: "objective-c" },
        { scheme: "untitled", language: "objective-c" },
        { scheme: "file", language: "objective-cpp" },
        { scheme: "untitled", language: "objective-cpp" },
    ];
    // document selector used by language client
    static cFamilyDocumentSelector: SourceKitDocumentSelector = [
        { scheme: "file", language: "c" },
        { scheme: "untitled", language: "c" },
        { scheme: "file", language: "cpp" },
        { scheme: "untitled", language: "cpp" },
    ];
    // document selector for swift-docc documentation
    static documentationDocumentSelector: SourceKitDocumentSelector = [
        { scheme: "file", language: "markdown" },
        { scheme: "untitled", language: "markdown" },
        { scheme: "file", language: "tutorial" },
        { scheme: "untitiled", language: "tutorial" },
    ];
    static get documentSelector(): DocumentSelector {
        let documentSelector: SourceKitDocumentSelector;
        switch (configuration.lsp.supportCFamily) {
            case "enable":
                documentSelector = [
                    ...LanguageClientManager.appleLangDocumentSelector,
                    ...LanguageClientManager.cFamilyDocumentSelector,
                ];
                break;

            case "disable":
                documentSelector = LanguageClientManager.appleLangDocumentSelector;
                break;

            case "cpptools-inactive": {
                const cppToolsActive =
                    vscode.extensions.getExtension("ms-vscode.cpptools")?.isActive;
                documentSelector =
                    cppToolsActive === true
                        ? LanguageClientManager.appleLangDocumentSelector
                        : [
                              ...LanguageClientManager.appleLangDocumentSelector,
                              ...LanguageClientManager.cFamilyDocumentSelector,
                          ];
            }
        }
        documentSelector = documentSelector.filter(doc => {
            return configuration.lsp.supportedLanguages.includes(doc.language);
        });
        documentSelector.push(...LanguageClientManager.documentationDocumentSelector);
        return documentSelector;
    }

    // build argument to sourcekit-lsp filter
    static buildArgumentFilter: ArgumentFilter[] = [
        { argument: "--build-path", include: 1 },
        { argument: "--scratch-path", include: 1 },
        { argument: "-Xswiftc", include: 1 },
        { argument: "-Xcc", include: 1 },
        { argument: "-Xcxx", include: 1 },
        { argument: "-Xlinker", include: 1 },
        { argument: "-Xclangd", include: 1 },
        { argument: "-index-store-path", include: 1 },
    ];

    /**
     * current running client
     *
     * undefined means not setup
     * null means in the process of restarting
     */
    private languageClient: LanguageClient | null | undefined;
    private cancellationToken?: vscode.CancellationTokenSource;
    private legacyInlayHints?: vscode.Disposable;
    private peekDocuments?: vscode.Disposable;
    private getReferenceDocument?: vscode.Disposable;
    private didChangeActiveDocument?: vscode.Disposable;
    private restartedPromise?: Promise<void>;
    private currentWorkspaceFolder?: vscode.Uri;
    private waitingOnRestartCount: number;
    private clientReadyPromise?: Promise<void>;
    public documentSymbolWatcher?: (
        document: vscode.TextDocument,
        symbols: vscode.DocumentSymbol[] | null | undefined
    ) => void;
    private subscriptions: { dispose(): unknown }[];
    private singleServerSupport: boolean;
    // used by single server support to keep a record of the project folders
    // that are not at the root of their workspace
    public subFolderWorkspaces: vscode.Uri[];
    private namedOutputChannels: Map<string, LSPOutputChannel> = new Map();
    private swiftVersion: Version;
    private activeDocumentManager = new LSPActiveDocumentManager();

    /** Get the current state of the underlying LanguageClient */
    public get state(): State {
        if (!this.languageClient) {
            return State.Stopped;
        }
        return this.languageClient.state;
    }

    constructor(
        public workspaceContext: WorkspaceContext,
        private languageClientFactory: LanguageClientFactory = new LanguageClientFactory()
    ) {
        this.namedOutputChannels.set(
            LanguageClientManager.indexingLogName,
            new LSPOutputChannel(LanguageClientManager.indexingLogName, false, true)
        );
        this.swiftVersion = workspaceContext.swiftVersion;
        this.singleServerSupport = this.swiftVersion.isGreaterThanOrEqual(new Version(5, 7, 0));
        this.subscriptions = [];
        this.subFolderWorkspaces = [];
        if (this.singleServerSupport) {
            this.subscriptions.push(
                // add/remove folders from server
                workspaceContext.onDidChangeFolders(async ({ folder, operation }) => {
                    if (!folder) {
                        return;
                    }
                    switch (operation) {
                        case FolderOperation.add:
                            await this.addFolder(folder);
                            break;
                        case FolderOperation.remove:
                            await this.removeFolder(folder);
                            break;
                    }
                })
            );
            this.setLanguageClientFolder(undefined);
        } else {
            this.subscriptions.push(
                // stop and start server for each folder based on which file I am looking at
                workspaceContext.onDidChangeFolders(async ({ folder, operation }) => {
                    switch (operation) {
                        case FolderOperation.add:
                            if (folder && folder.folder) {
                                // if active document is inside folder then setup language client
                                if (this.isActiveFileInFolder(folder.folder)) {
                                    await this.setLanguageClientFolder(folder.folder);
                                }
                            }
                            break;
                        case FolderOperation.focus:
                            await this.setLanguageClientFolder(folder?.folder);
                            break;
                    }
                })
            );
        }
        // on change config restart server
        const onChangeConfig = vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration("swift.sourcekit-lsp")) {
                return;
            }
            let message =
                "Changing SourceKit-LSP settings requires the language server be restarted. Would you like to restart it now?";
            let restartLSPButton = "Restart Language Server";
            // Enabling/Disabling sourcekit-lsp shows a special notification
            if (event.affectsConfiguration("swift.sourcekit-lsp.disable")) {
                if (configuration.lsp.disable) {
                    if (this.state === State.Stopped) {
                        // Language client is already stopped
                        return;
                    }
                    message = `You have disabled the Swift language server, but it is still running. Would you like to stop it now?
                        This will turn off features such as code completion, error diagnostics, jump-to-definition, and test discovery.`;
                    restartLSPButton = "Stop Language Server";
                } else {
                    if (this.state !== State.Stopped) {
                        // Langauge client is already running
                        return;
                    }
                    message =
                        "You have enabled the Swift language server. Would you like to start it now?";
                    restartLSPButton = "Start Language Server";
                }
            } else if (configuration.lsp.disable && this.state === State.Stopped) {
                // Ignore configuration changes if SourceKit-LSP is disabled
                return;
            }
            vscode.window.showInformationMessage(message, restartLSPButton).then(selected => {
                if (selected === restartLSPButton) {
                    this.restart();
                }
            });
        });

        this.subscriptions.push(onChangeConfig);

        // Swift versions prior to 5.6 don't support file changes, so need to restart
        // lSP server when a file is either created or deleted
        if (workspaceContext.swiftVersion.isLessThan(new Version(5, 6, 0))) {
            workspaceContext.outputChannel.logDiagnostic("LSP: Adding new/delete file handlers");
            // restart LSP server on creation of a new file
            const onDidCreateFileDisposable = vscode.workspace.onDidCreateFiles(() => {
                this.restart();
            });
            // restart LSP server on deletion of a file
            const onDidDeleteFileDisposable = vscode.workspace.onDidDeleteFiles(() => {
                this.restart();
            });
            this.subscriptions.push(onDidCreateFileDisposable, onDidDeleteFileDisposable);
        }

        this.waitingOnRestartCount = 0;
        this.documentSymbolWatcher = undefined;
        this.cancellationToken = new vscode.CancellationTokenSource();
    }

    // The language client stops asnyhronously, so we need to wait for it to stop
    // instead of doing it in dispose, which must be synchronous.
    async stop() {
        if (this.languageClient && this.languageClient.state === State.Running) {
            await this.languageClient.dispose();
        }
    }

    dispose() {
        this.cancellationToken?.cancel();
        this.cancellationToken?.dispose();
        this.legacyInlayHints?.dispose();
        this.peekDocuments?.dispose();
        this.getReferenceDocument?.dispose();
        this.subscriptions.forEach(item => item.dispose());
        this.namedOutputChannels.forEach(channel => channel.dispose());
    }

    /**
     * Use language client safely. Provides a cancellation token to the function
     * which can be used to safely ensure language client request are cancelled
     * if the language is shutdown.
     * @param process process using language client
     * @returns result of process
     */
    async useLanguageClient<Return>(process: {
        (client: LanguageClient, cancellationToken: vscode.CancellationToken): Promise<Return>;
    }): Promise<Return> {
        if (!this.languageClient || !this.clientReadyPromise) {
            throw new Error(LanguageClientError.LanguageClientUnavailable);
        }
        return this.clientReadyPromise.then(
            () => {
                if (!this.languageClient || !this.cancellationToken) {
                    throw new Error(LanguageClientError.LanguageClientUnavailable);
                }
                return process(this.languageClient, this.cancellationToken.token);
            },
            reason => reason
        );
    }

    /** Restart language client */
    async restart() {
        // force restart of language client
        await this.setLanguageClientFolder(this.currentWorkspaceFolder, true);
    }

    get languageClientOutputChannel(): SwiftOutputChannel | undefined {
        return this.languageClient?.outputChannel as SwiftOutputChannel | undefined;
    }

    private async addFolder(folderContext: FolderContext) {
        if (!folderContext.isRootFolder) {
            await this.useLanguageClient(async client => {
                const uri = folderContext.folder;
                this.subFolderWorkspaces.push(folderContext.folder);

                const workspaceFolder = {
                    uri: client.code2ProtocolConverter.asUri(uri),
                    name: FolderContext.uriName(uri),
                };
                client.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
                    event: { added: [workspaceFolder], removed: [] },
                });
            });
        }
    }

    private async removeFolder(folderContext: FolderContext) {
        if (!folderContext.isRootFolder) {
            await this.useLanguageClient(async client => {
                const uri = folderContext.folder;
                this.subFolderWorkspaces = this.subFolderWorkspaces.filter(item => item !== uri);

                const workspaceFolder = {
                    uri: client.code2ProtocolConverter.asUri(uri),
                    name: FolderContext.uriName(uri),
                };
                client.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
                    event: { added: [], removed: [workspaceFolder] },
                });
            });
        }
    }

    private async addSubFolderWorkspaces(client: LanguageClient) {
        for (const uri of this.subFolderWorkspaces) {
            const workspaceFolder = {
                uri: client.code2ProtocolConverter.asUri(uri),
                name: FolderContext.uriName(uri),
            };
            client.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
                event: { added: [workspaceFolder], removed: [] },
            });
        }
    }

    /** Set folder for LSP server
     *
     * If server is already running then check if the workspace folder is the same if
     * it isn't then restart the server using the new workspace folder.
     */
    private async setLanguageClientFolder(uri?: vscode.Uri, forceRestart = false) {
        if (this.languageClient === undefined) {
            this.currentWorkspaceFolder = uri;
            this.restartedPromise = this.setupLanguageClient(uri);
            return;
        } else {
            // don't check for undefined uri's or if the current workspace is the same if we are
            // running a single server. The only way we can get here while using a single server
            // is when restart is called.
            if (!this.singleServerSupport) {
                if (uri === undefined || (this.currentWorkspaceFolder === uri && !forceRestart)) {
                    return;
                }
            }
            let workspaceFolder: vscode.WorkspaceFolder | undefined;
            if (uri) {
                workspaceFolder = {
                    uri: uri,
                    name: FolderContext.uriName(uri),
                    index: 0,
                };
            }
            await this.restartLanguageClient(workspaceFolder);
        }
    }

    /**
     * Restart language client using supplied workspace folder
     * @param workspaceFolder workspace folder to send to server
     * @returns when done
     */
    private async restartLanguageClient(workspaceFolder: vscode.WorkspaceFolder | undefined) {
        // count number of setLanguageClientFolder calls waiting on startedPromise
        this.waitingOnRestartCount += 1;
        // if in the middle of a restart then we have to wait until that
        // restart has finished
        if (this.restartedPromise) {
            try {
                await this.restartedPromise;
            } catch (error) {
                //ignore error
            }
        }
        this.waitingOnRestartCount -= 1;
        // only continue if no more calls are waiting on startedPromise
        if (this.waitingOnRestartCount !== 0) {
            return;
        }

        const client = this.languageClient;
        // language client is set to null while it is in the process of restarting
        this.languageClient = null;
        this.currentWorkspaceFolder = workspaceFolder?.uri;
        this.legacyInlayHints?.dispose();
        this.legacyInlayHints = undefined;
        this.peekDocuments?.dispose();
        this.peekDocuments = undefined;
        this.getReferenceDocument?.dispose();
        this.getReferenceDocument = undefined;
        if (client) {
            this.cancellationToken?.cancel();
            this.cancellationToken?.dispose();
            this.restartedPromise = client
                .stop()
                .then(async () => {
                    await this.setupLanguageClient(workspaceFolder?.uri);

                    // Now that the client has been replaced, dispose the old client's output channel.
                    client.outputChannel.dispose();
                })
                .catch(async reason => {
                    // error message matches code here https://github.com/microsoft/vscode-languageserver-node/blob/2041784436fed53f4e77267a49396bca22a7aacf/client/src/common/client.ts#L1409C1-L1409C54
                    if (reason.message === "Stopping the server timed out") {
                        await this.setupLanguageClient(workspaceFolder?.uri);
                    }
                    this.workspaceContext.outputChannel.log(`${reason}`);
                });
            await this.restartedPromise;
        }
    }

    private isActiveFileInFolder(uri: vscode.Uri): boolean {
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
            // if active document is inside folder then setup language client
            const activeDocPath = vscode.window.activeTextEditor.document.uri.fsPath;
            if (isPathInsidePath(activeDocPath, uri.fsPath)) {
                return true;
            }
        }
        return false;
    }

    private async setupLanguageClient(folder?: vscode.Uri) {
        if (configuration.lsp.disable) {
            this.languageClient = undefined;
            return;
        }
        const { client, errorHandler } = this.createLSPClient(folder);
        return this.startClient(client, errorHandler);
    }

    private createLSPClient(folder?: vscode.Uri): {
        client: LanguageClient;
        errorHandler: SourceKitLSPErrorHandler;
    } {
        const toolchainSourceKitLSP =
            this.workspaceContext.toolchain.getToolchainExecutable("sourcekit-lsp");
        const lspConfig = configuration.lsp;
        const serverPathConfig = lspConfig.serverPath;
        const serverPath = serverPathConfig.length > 0 ? serverPathConfig : toolchainSourceKitLSP;
        const buildFlags = this.workspaceContext.toolchain.buildFlags;
        const sdkArguments = [
            ...buildFlags.swiftDriverSDKFlags(true),
            ...buildFlags.swiftDriverTargetFlags(true),
            ...BuildFlags.filterArguments(
                configuration.buildArguments.concat(buildFlags.buildPathFlags()),
                LanguageClientManager.buildArgumentFilter
            ),
        ];

        const sourcekit: Executable = {
            command: serverPath,
            args: lspConfig.serverArguments.concat(sdkArguments),
            options: {
                env: {
                    ...process.env,
                    ...configuration.swiftEnvironmentVariables,
                    ...swiftRuntimeEnv(),
                },
            },
        };

        // if path to LSP server is not equal to the path to swift and both are set, then
        // pass swift toolchain to the LSP server
        if (
            serverPathConfig.length > 0 &&
            configuration.path.length > 0 &&
            serverPathConfig !== toolchainSourceKitLSP
        ) {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            sourcekit.options = {
                env: {
                    ...sourcekit.options?.env,
                    SOURCEKIT_TOOLCHAIN_PATH: this.workspaceContext.toolchain.toolchainPath,
                },
            };
        }

        const serverOptions: ServerOptions = sourcekit;
        let workspaceFolder = undefined;
        if (folder) {
            workspaceFolder = { uri: folder, name: FolderContext.uriName(folder), index: 0 };
        }

        const errorHandler = new SourceKitLSPErrorHandler(5);
        const clientOptions: LanguageClientOptions = {
            documentSelector: LanguageClientManager.documentSelector,
            revealOutputChannelOn: RevealOutputChannelOn.Never,
            workspaceFolder: workspaceFolder,
            outputChannel: new SwiftOutputChannel("SourceKit Language Server"),
            middleware: {
                didOpen: this.activeDocumentManager.didOpen.bind(this.activeDocumentManager),
                didClose: this.activeDocumentManager.didClose.bind(this.activeDocumentManager),
                provideCodeLenses: async (document, token, next) => {
                    const result = await next(document, token);
                    return result?.map(codelens => {
                        switch (codelens.command?.command) {
                            case "swift.run":
                                codelens.command.title = `$(play) ${codelens.command.title}`;
                                break;
                            case "swift.debug":
                                codelens.command.title = `$(debug) ${codelens.command.title}`;
                                break;
                        }
                        return codelens;
                    });
                },
                provideDocumentSymbols: async (document, token, next) => {
                    const result = await next(document, token);
                    const documentSymbols = result as vscode.DocumentSymbol[];
                    if (this.documentSymbolWatcher && documentSymbols) {
                        this.documentSymbolWatcher(document, documentSymbols);
                    }
                    return result;
                },
                provideDefinition: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    const definitions = result as vscode.Location[];
                    if (
                        definitions &&
                        path.extname(definitions[0].uri.path) === ".swiftinterface" &&
                        definitions[0].uri.scheme === "file"
                    ) {
                        const uri = definitions[0].uri.with({ scheme: "readonly" });
                        return new vscode.Location(uri, definitions[0].range);
                    }
                    return result;
                },
                // temporarily remove text edit from Inlay hints while SourceKit-LSP
                // returns invalid replacement text
                provideInlayHints: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    // remove textEdits for swift version earlier than 5.10 as it sometimes
                    // generated invalid textEdits
                    if (this.workspaceContext.swiftVersion.isLessThan(new Version(5, 10, 0))) {
                        result?.forEach(r => (r.textEdits = undefined));
                    }
                    return result;
                },
                provideDiagnostics: async (uri, previousResultId, token, next) => {
                    const result = await next(uri, previousResultId, token);
                    if (result?.kind === vsdiag.DocumentDiagnosticReportKind.unChanged) {
                        return undefined;
                    }
                    const document = uri as vscode.TextDocument;
                    this.workspaceContext.diagnostics.handleDiagnostics(
                        document.uri ?? uri,
                        DiagnosticsManager.isSourcekit,
                        result?.items ?? []
                    );
                    return undefined;
                },
                handleDiagnostics: (uri, diagnostics) => {
                    this.workspaceContext.diagnostics.handleDiagnostics(
                        uri,
                        DiagnosticsManager.isSourcekit,
                        diagnostics
                    );
                },
                handleWorkDoneProgress: (() => {
                    let lastPrompted = new Date(0).getTime();
                    return async (token, params, next) => {
                        const result = await next(token, params);
                        const now = new Date().getTime();
                        const oneHour = 60 * 60 * 1000;
                        if (
                            now - lastPrompted > oneHour &&
                            token.toString().startsWith("sourcekitd-crashed")
                        ) {
                            // Only prompt once an hour in case sourcekit is in a crash loop
                            lastPrompted = now;
                            promptForDiagnostics(this.workspaceContext);
                        }
                        return result;
                    };
                })(),
            },
            uriConverters,
            errorHandler,
            // Avoid attempting to reinitialize multiple times. If we fail to initialize
            // we aren't doing anything different the second time and so will fail again.
            initializationFailedHandler: () => false,
            initializationOptions: this.initializationOptions(),
        };

        return {
            client: this.languageClientFactory.createLanguageClient(
                "swift.sourcekit-lsp",
                "SourceKit Language Server",
                serverOptions,
                clientOptions
            ),
            errorHandler,
        };
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    private initializationOptions(): any {
        let options: any = {
            "workspace/peekDocuments": true, // workaround for client capability to handle `PeekDocumentsRequest`
            "workspace/getReferenceDocument": true, // the client can handle URIs with scheme `sourcekit-lsp:`
            "textDocument/codeLens": {
                supportedCommands: {
                    "swift.run": "swift.run",
                    "swift.debug": "swift.debug",
                },
            },
        };

        // Swift 6.0.0 and later supports background indexing.
        // In 6.0.0 it is experimental so only "true" enables it.
        // In 6.1.0 it is no longer experimental, and so "auto" or "true" enables it.
        if (
            this.swiftVersion.isGreaterThanOrEqual(new Version(6, 0, 0)) &&
            (configuration.backgroundIndexing === "on" ||
                (configuration.backgroundIndexing === "auto" &&
                    this.swiftVersion.isGreaterThanOrEqual(new Version(6, 1, 0))))
        ) {
            options = {
                ...options,
                backgroundIndexing: true,
                backgroundPreparationMode: "enabled",
            };
        }

        if (this.swiftVersion.isGreaterThanOrEqual(new Version(6, 1, 0))) {
            options = {
                ...options,
                "window/didChangeActiveDocument": true, // the client can send `window/didChangeActiveDocument` notifications
            };
        }

        if (configuration.swiftSDK !== "") {
            options = {
                ...options,
                swiftPM: { swiftSDK: configuration.swiftSDK },
            };
        }

        return options;
    }

    private async startClient(client: LanguageClient, errorHandler: SourceKitLSPErrorHandler) {
        client.onDidChangeState(e => {
            // if state is now running add in any sub-folder workspaces that
            // we have cached. If this is the first time we are starting then
            // we won't have any sub folder workspaces, but if the server crashed
            // or we forced a restart then we need to do this
            if (e.oldState === State.Starting && e.newState === State.Running) {
                this.addSubFolderWorkspaces(client);
            }
        });
        if (client.clientOptions.workspaceFolder) {
            this.workspaceContext.outputChannel.log(
                `SourceKit-LSP setup for ${FolderContext.uriName(
                    client.clientOptions.workspaceFolder.uri
                )}`
            );
        } else {
            this.workspaceContext.outputChannel.log(`SourceKit-LSP setup`);
        }

        client.onNotification(SourceKitLogMessageNotification.type, params => {
            this.logMessage(client, params as SourceKitLogMessageParams);
        });

        // start client
        this.clientReadyPromise = client
            .start()
            .then(() => {
                // Now that we've started up correctly, start the error handler to auto-restart
                // if sourcekit-lsp crashes during normal operation.
                errorHandler.enable();

                if (this.workspaceContext.swiftVersion.isLessThan(new Version(5, 7, 0))) {
                    this.legacyInlayHints = activateLegacyInlayHints(client);
                }

                this.peekDocuments = activatePeekDocuments(client);
                this.getReferenceDocument = activateGetReferenceDocument(client);
                this.workspaceContext.subscriptions.push(this.getReferenceDocument);
                try {
                    if (
                        checkExperimentalCapability(
                            client,
                            DidChangeActiveDocumentNotification.method,
                            1
                        )
                    ) {
                        this.didChangeActiveDocument =
                            this.activeDocumentManager.activateDidChangeActiveDocument(client);
                        this.workspaceContext.subscriptions.push(this.didChangeActiveDocument);
                    }
                } catch {
                    // do nothing
                }
            })
            .catch(reason => {
                this.workspaceContext.outputChannel.log(`${reason}`);
                this.languageClient?.stop();
                this.languageClient = undefined;
                throw reason;
            });

        this.languageClient = client;
        this.cancellationToken = new vscode.CancellationTokenSource();

        return this.clientReadyPromise;
    }

    private logMessage(client: LanguageClient, params: SourceKitLogMessageParams) {
        let logger: LSPLogger = client;
        if (params.logName) {
            const outputChannel =
                this.namedOutputChannels.get(params.logName) ??
                new LSPOutputChannel(params.logName);
            this.namedOutputChannels.set(params.logName, outputChannel);
            logger = outputChannel;
        }
        switch (params.type) {
            case MessageType.Info:
                logger.info(params.message);
                break;
            case MessageType.Debug:
                logger.debug(params.message);
                break;
            case MessageType.Warning:
                logger.warn(params.message);
                break;
            case MessageType.Error:
                logger.error(params.message);
                break;
            case MessageType.Log:
                logger.info(params.message);
                break;
        }
    }
}

/**
 * SourceKit-LSP error handler. Copy of the default error handler, except it includes
 * an error message that asks if you want to restart the sourcekit-lsp server again
 * after so many crashes
 */
export class SourceKitLSPErrorHandler implements ErrorHandler {
    private restarts: number[];
    private enabled: boolean = false;

    constructor(private maxRestartCount: number) {
        this.restarts = [];
    }
    /**
     * Start listening for errors and requesting to restart the LSP server when appropriate.
     */
    enable() {
        this.enabled = true;
    }
    /**
     * An error has occurred while writing or reading from the connection.
     *
     * @param _error - the error received
     * @param _message - the message to be delivered to the server if know.
     * @param count - a count indicating how often an error is received. Will
     *  be reset if a message got successfully send or received.
     */
    error(
        _error: Error,
        _message: Message | undefined,
        count: number | undefined
    ): ErrorHandlerResult | Promise<ErrorHandlerResult> {
        if (count && count <= 3) {
            return { action: ErrorAction.Continue };
        }
        return { action: ErrorAction.Shutdown };
    }
    /**
     * The connection to the server got closed.
     */
    closed(): CloseHandlerResult | Promise<CloseHandlerResult> {
        if (!this.enabled) {
            return {
                action: CloseAction.DoNotRestart,
                handled: true,
            };
        }

        this.restarts.push(Date.now());
        if (this.restarts.length <= this.maxRestartCount) {
            return { action: CloseAction.Restart };
        } else {
            const diff = this.restarts[this.restarts.length - 1] - this.restarts[0];
            if (diff <= 3 * 60 * 1000) {
                return new Promise<CloseHandlerResult>(resolve => {
                    vscode.window
                        .showErrorMessage(
                            `The SourceKit-LSP server crashed ${
                                this.maxRestartCount + 1
                            } times in the last 3 minutes. See the output for more information. Do you want to restart it again.`,
                            "Yes",
                            "No"
                        )
                        .then(result => {
                            if (result === "Yes") {
                                this.restarts = [];
                                resolve({ action: CloseAction.Restart });
                            } else {
                                resolve({ action: CloseAction.DoNotRestart });
                            }
                        });
                });
            } else {
                this.restarts.shift();
                return { action: CloseAction.Restart };
            }
        }
    }
}

/** Language client errors */
export const enum LanguageClientError {
    LanguageClientUnavailable = "Language Client Unavailable",
}

type SourceKitDocumentSelector = {
    scheme: string;
    language: string;
}[];

/**
 * Returns `true` if the LSP supports the supplied `method` at or
 * above the supplied `minVersion`.
 */
export function checkExperimentalCapability(
    client: LanguageClient,
    method: string,
    minVersion: number
) {
    const experimentalCapability = client.initializeResult?.capabilities.experimental;
    if (!experimentalCapability) {
        throw new Error(`${method} requests not supported`);
    }
    const targetCapability = experimentalCapability[method];
    return (targetCapability?.version ?? -1) >= minVersion;
}
