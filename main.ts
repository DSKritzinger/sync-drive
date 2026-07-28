import { getDriveClient } from "helpers/drive";
import {
	checkConnection,
	getAuthServerUrl,
	refreshAccessToken,
} from "helpers/auth";
import { normalizeAuthServerUrl } from "helpers/auth-server-url";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	Menu,
} from "obsidian";

interface PluginSettings {
	authServerUrl: string;
	authProxyKey: string;
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	authServerUrl: "",
	authProxyKey: "",
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (
			!this.settings.authServerUrl ||
			!this.settings.authProxyKey ||
			!this.settings.refreshToken
		) {
			new Notice(
				"Configure the auth server URL, auth proxy key, and refresh token in Google Drive Sync settings. Back up your vault and read the setup instructions before syncing.",
				0
			);
			return;
		}

		try {
			this.settings.authServerUrl = normalizeAuthServerUrl(
				this.settings.authServerUrl
			);
		} catch (error) {
			new Notice(
				error instanceof Error
					? error.message
					: "The auth server URL is invalid.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Obsidian Google Drive",
			(event) => {
				if (this.syncing) return;
				const menu = new Menu();

				menu.addItem((item) =>
					item
						.setTitle("Pull from Drive")
						.setIcon("cloud-download")
						.onClick(() => {
							pull(this);
						})
				);

				menu.addItem((item) =>
					item
						.setTitle("Push to Drive")
						.setIcon("cloud-upload")
						.onClick(() => {
							push(this);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Reset from Drive")
						.setIcon("triangle-alert")
						.onClick(() => {
							reset(this);
						})
				);
				menu.showAtMouseEvent(event);
			}
		);

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection(this).then(async (connectionStatus) => {
			if (connectionStatus === "connected") {
				const refreshed = await refreshAccessToken(this);
				if (!refreshed.ok) return;
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				await pull(this, true);
				await this.endSync();
			} else if (connectionStatus === "unreachable") {
				new Notice(
					"The configured auth server could not be reached. Automatic sync was skipped."
				);
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = "delete";
		}
		this.debouncedSaveSettings();
	}

	handleModify(file: TFile) {
		const operation = this.settings.operations[file.path];
		if (operation === "create" || operation === "modify") {
			return;
		}
		this.settings.operations[file.path] = "modify";
		this.debouncedSaveSettings();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!this.settings.authProxyKey || !this.settings.refreshToken) {
			new Notice(
				"Configure the auth proxy key and refresh token before syncing."
			);
			return;
		}

		try {
			this.settings.authServerUrl = getAuthServerUrl(this);
		} catch (error) {
			new Notice(
				error instanceof Error
					? error.message
					: "The auth server URL is invalid."
			);
			return;
		}

		const connectionStatus = await checkConnection(this);
		if (connectionStatus !== "connected") {
			new Notice(
				connectionStatus === "invalid_configuration"
					? "The auth server URL is invalid."
					: "The configured auth server could not be reached. Check its URL, availability, and your network connection."
			);
			return;
		}

		if (!this.accessToken.token) {
			const refreshed = await refreshAccessToken(this);
			if (!refreshed.ok) return;
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			this.settings.lastSyncedAt = Date.now();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() }
					)
				)
			);
		} else {
			this.settings.lastSyncedAt = Date.now();
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			return new Notice(
				"An error occurred fetching Google Drive changes token."
			);
		}
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice?.hide();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const { vault } = this.app;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Auth server URL")
			.setDesc(
				"HTTPS URL of your self-hosted auth server. HTTP is allowed only for localhost, 127.0.0.1, and [::1]."
			)
			.addText((text) => {
				text.setPlaceholder("https://auth.example.com")
					.setValue(this.plugin.settings.authServerUrl)
					.onChange((value) => {
						this.plugin.settings.authServerUrl = value.trim();
						this.plugin.accessToken = { token: "", expiresAt: 0 };
						this.plugin.debouncedSaveSettings();
					});

				text.inputEl.addEventListener("blur", async () => {
					if (!this.plugin.settings.authServerUrl) return;
					try {
						const normalized = normalizeAuthServerUrl(
							this.plugin.settings.authServerUrl
						);
						this.plugin.settings.authServerUrl = normalized;
						text.setValue(normalized);
						await this.plugin.saveSettings();
						this.display();
					} catch (error) {
						new Notice(
							error instanceof Error
								? error.message
								: "The auth server URL is invalid."
						);
					}
				});
			});

		new Setting(containerEl)
			.setName("Auth proxy key")
			.setDesc(
				"Must match AUTH_PROXY_KEY on your auth server. It is stored in this plugin's local data."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("Enter your auth proxy key")
					.setValue(this.plugin.settings.authProxyKey)
					.onChange((value) => {
						this.plugin.settings.authProxyKey = value;
						this.plugin.accessToken = { token: "", expiresAt: 0 };
						this.plugin.debouncedSaveSettings();
					});
			});

		try {
			containerEl.createEl("a", {
				href: `${getAuthServerUrl(this.plugin)}/auth`,
				text: "Get a refresh token from the configured auth server",
			});
		} catch {
			containerEl.createEl("p", {
				text: "Configure a valid auth server URL to get a refresh token.",
			});
		}

		const cancelRefreshToken = async () => {
			this.plugin.settings.refreshToken = "";
			this.plugin.accessToken = { token: "", expiresAt: 0 };
			await this.plugin.saveSettings();
			this.display();
		};

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc(
				"A refresh token issued by the configured server's Google OAuth client is required. Back up your vault and follow the empty-vault migration instructions before syncing."
			)
			.addText((text) => {
				text.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange((value) => {
						this.plugin.settings.refreshToken = value;
						this.plugin.accessToken = { token: "", expiresAt: 0 };
						this.plugin.debouncedSaveSettings();
					});
			})
			.addButton((button) =>
				button.setButtonText("Validate and save").onClick(async () => {
					button.setDisabled(true);
					try {
						const result = await refreshAccessToken(this.plugin);
						if (!result.ok) return;
						if (
							vault
								.getAllLoadedFiles()
								.filter(({ path }) => path !== "/").length > 0
						) {
							new Notice(
								"Your current vault is not empty! If you want our plugin to handle the initial sync, you have to clear out the current vault. Check the readme or website for more details.",
								0
							);
							return cancelRefreshToken();
						}

						const changesToken =
							await this.plugin.drive.getChangesStartToken();
						if (!changesToken) {
							return new Notice(
								"An error occurred fetching Google Drive changes token."
							);
						}
						this.plugin.settings.changesToken = changesToken;

						await this.plugin.saveSettings();
						new Notice(
							"Refresh token saved! Reload Obsidian to activate sync.",
							0
						);
					} finally {
						button.setDisabled(false);
					}
				})
			);
	}
}
