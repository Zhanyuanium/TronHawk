// Lightweight runtime i18n for the Manager UI.
// zh is the primary authored language; en is the fallback baseline.
// Lookup order: current language dict, then en, then the key itself.

const STORAGE_KEY = "tronhawk.language";

const dictionaries = {
  en: {
    "app.title": "TronHawk Manager",

    "error.generic": "Core did not complete the request.",

    "common.dismiss": "Dismiss",
    "common.tryAgain": "Try again",
    "common.cancel": "Cancel",

    "nav.group.workspace": "Workspace",
    "nav.group.system": "System",
    "nav.aria": "Manager sections",
    "nav.applications": "Applications",
    "nav.plugins": "Plugins",
    "nav.permissions": "Permissions",
    "nav.logs": "Logs",
    "nav.settings": "Settings",

    "sidebar.footer.title": "Core control plane",
    "sidebar.footer.desc": "Policies are scoped to the selected application and saved through Core.",

    "notice.connected.title": "Connected to Core.",
    "notice.connected.desc": "Application policies shown here reflect the latest Manager snapshot.",

    "loading.aria": "Loading",
    "loading.title": "Loading Core snapshot",
    "loading.desc": "Reading registered applications and installed plugin policies.",

    "failure.title": "Couldn’t reach Core",
    "failure.desc": "The Manager snapshot could not be loaded.",

    "level.0": "Level 0 · Unsupported",
    "level.1": "Level 1 · Renderer",
    "level.2": "Level 2 · Electron",

    "action.install": "＋ Install plugin",
    "action.addApplication": "＋ Add application",
    "action.addApplicationPlain": "Add application",
    "action.launch": "Launch",
    "action.launch.withExtensions": "Launch {name} with extensions",
    "action.refresh": "↻ Refresh",
    "action.loadOlder": "Load older",
    "action.viewLogs": "View log status",
    "action.removeApp": "Remove application",

    "context.aria": "Selected application policy",
    "context.label": "Policy scope",
    "context.currentApplication": "Current application",
    "context.registeredExecutable": "Registered local executable",
    "context.selectAria": "Current application policy",

    "summary.connection": "Connection state",
    "summary.connectedValue": "Core connected",
    "summary.connectedFor": "Policies shown for {name}.",
    "summary.connectedEmpty": "Add an application to begin setting plugin policies.",
    "summary.applications": "Applications",
    "summary.applicationsDetail": "Registered with Core",
    "summary.enabledHere": "Enabled here",
    "summary.enabledFor": "Policies for this application",
    "summary.enabledChoose": "Choose an application to review policies",

    "applications.eyebrow": "Overview",
    "applications.title": "Your extension workspace",
    "applications.desc": "Manage installed plugins and application-scoped Core policies.",
    "applications.panelTitle": "Applications",
    "applications.chooseScope": "Choose a policy scope",
    "applications.startWithExecutable": "Start with a registered executable",
    "applications.coreActivity": "Core activity",
    "applications.activityTitle": "Awaiting Core ingestion",
    "applications.activityDesc": "Activity is not included in the Manager snapshot.",

    "empty.addFirst.title": "Add your first application",
    "empty.addFirst.desc": "Choose a support level, then select an executable in the native picker. Core will register it as a policy scope.",
    "empty.needApp.title": "Add an application first",
    "empty.needApp.desc": "Choose a support level, then select an executable in the native picker to create a Core policy scope.",

    "appcard.registeredExecutable": "Registered local executable",
    "appcard.enabled": "{count} enabled",
    "appcard.selectAria": "Select {name} as the policy scope",
    "appcard.launchHelp.disabled": "Level 0 applications cannot be launched with extensions",
    "appcard.remove": "Remove {name}",
    "appcard.removeAria": "Remove {name} from the workspace",

    "iefo.title": "Transparent launch (IFEO)",
    "iefo.detail": "When enabled, double-clicking this application outside the Manager launches it through TronHawk with its policies applied.",
    "iefo.on": "Transparent launch is on. External double-clicks run through TronHawk.",
    "iefo.off": "Transparent launch is off. External double-clicks run the application directly.",
    "iefo.loading": "Reading transparent launch status…",
    "iefo.ownedNote": "This application’s launch registration is owned by another program, so TronHawk cannot manage it here.",
    "iefo.toggleOn": "Turn off transparent launch for {name}",
    "iefo.toggleOff": "Turn on transparent launch for {name}",
    "iefo.notice.enabled": "Transparent launch enabled. External double-clicks now run through TronHawk.",
    "iefo.notice.disabled": "Transparent launch disabled. External double-clicks run the application directly.",
    "iefo.notice.cancelled": "Elevation canceled. The transparent launch setting was not changed.",

    "plugins.eyebrow": "Installed packages",
    "plugins.title": "Plugins",
    "plugins.desc": "Each switch updates the full policy for the current application in Core.",
    "plugins.descEmpty": "Add an application before setting plugin policies.",
    "plugins.filterAria": "Filter plugins",
    "plugins.filter.all": "All",
    "plugins.filter.enabled": "Enabled",
    "plugins.filter.disabled": "Disabled",
    "plugins.summary": "{total} of {shown} packages · {application}",
    "plugins.noApplicationName": "No application selected",
    "plugins.noneForFilter": "No {filter} plugins for this application",
    "plugins.noPluginsTitle": "No plugins installed",
    "plugins.noneForFilter.desc": "Install a .thx package or choose another policy scope.",

    "plugin.author": "Author: {author} · Requires TronHawk {version}",
    "plugin.policyOne": "{count} app policy",
    "plugin.policyOther": "{count} app policies",
    "plugin.permissions": "Permissions",
    "plugin.removeAria": "Remove {name}",
    "plugin.toggle.enableFor": "Enable {name} for the selected application",
    "plugin.toggle.disableFor": "Disable {name} for the selected application",
    "plugin.toggle.disabled": "Level 0 applications cannot enable plugins",

    "permissions.eyebrow": "Safety review",
    "permissions.title": "Permissions",
    "permissions.desc": "Grants belong to the selected application policy and are saved through Core.",
    "permissions.descEmpty": "Add an application before reviewing application-scoped grants.",
    "permissions.descNoPlugins": "Review the capabilities requested by each installed package.",
    "permissions.installedPlugins": "Installed plugins",
    "permissions.enabledFor": "Enabled for {application}",
    "permissions.disabledFor": "Disabled for {application}",
    "permissions.requestedCaps": "Requested capabilities",
    "permissions.noCaps": "This package did not request any capabilities.",
    "permissions.note": "Only capabilities available at {level} can be granted. Grant changes preserve the rest of this plugin’s policy.",
    "permissions.policyVersion": "{application} policy · v{version}",
    "permissions.noPlugins.title": "No plugins to review",
    "permissions.noPlugins.desc": "Installed packages will appear here.",

    "permission.granted": "Granted",
    "permission.withheld": "Withheld",
    "permission.unavailable": "Unavailable here",
    "permission.risk": "{risk} risk",
    "permission.risk.low": "low",
    "permission.risk.medium": "medium",
    "permission.risk.high": "high",
    "permission.risk.unknown": "unknown",
    "permission.grantAria": "Grant {permission} for the selected application",
    "permission.revokeAria": "Revoke {permission} for the selected application",

    "perm.renderer.css": "Allows the plugin’s renderer CSS to be applied.",
    "perm.renderer.script": "Allows the plugin’s renderer script to run.",
    "perm.electron.window": "Allows the plugin to work with managed application windows.",
    "perm.runtime.unsafe": "Grants raw Node.js + Electron in the target app — arbitrary code execution. Developer mode only.",
    "perm.default": "Requested by this plugin.",

    "config.pluginSettings": "Plugin settings",
    "config.fieldType": "{type} field",
    "config.turnOn": "Turn on",
    "config.turnOff": "Turn off",
    "config.on": "On",
    "config.off": "Off",
    "config.toggleAria": "{action} {label} for the selected application",
    "config.fieldAria": "{label} ({type}) for the selected application",
    "config.storedIn": "Settings are stored per application and included in {name}’s launch plan. A change updates the running plugin within a couple of seconds (the runtime reloads it with the new plan).",

    "settings.eyebrow": "Manager settings",
    "settings.title": "Settings",
    "settings.desc": "Control-plane options that decide which capabilities Core can grant to installed plugins.",
    "settings.devMode.title": "Developer mode",
    "settings.devMode.desc": "Unlock capabilities Core withholds from normal plugin policies.",
    "settings.devMode.toggleOn": "Developer mode is on. Click to turn it off.",
    "settings.devMode.toggleOff": "Developer mode is off. Click to turn it on.",
    "settings.devMode.ariaOn": "Disable developer mode",
    "settings.devMode.ariaOff": "Enable developer mode",
    "settings.devMode.warning": "Plugins granted runtime.unsafe run with full Node/Electron access in the target app — they can read files, access the network, read app data, and even terminate the app. Only enable for plugins you wrote or fully trust.",
    "settings.devMode.explain": "Developer mode gates the most powerful plugin permissions behind an explicit choice. Leave it off unless you need to grant runtime.unsafe to a plugin you wrote or fully trust.",
    "settings.devMode.offNote": "While developer mode is off, runtime.unsafe is not part of any application’s grantable capabilities, so Core will not apply new grants for it.",
    "settings.guide.node.title": "Node.js + Electron",
    "settings.guide.node.desc": "runtime.unsafe is the SDK’s strongest capability: a granted plugin runs with full process access inside the target app.",
    "settings.guide.l2.title": "Level 2 applications",
    "settings.guide.l2.desc": "While developer mode is on, the Permissions view lists runtime.unsafe as grantable for applications registered at Level 2.",
    "settings.guide.reversible.title": "Reversible",
    "settings.guide.reversible.desc": "Turning developer mode off takes runtime.unsafe out of the grantable set. Existing application policies are left untouched.",
    "settings.system.title": "System",
    "settings.system.desc": "Interface and start-up preferences managed by the Manager.",
    "settings.language.title": "Language",
    "settings.language.desc": "Choose the interface language.",
    "settings.language.optionEn": "English",
    "settings.language.optionZh": "中文",
    "settings.autostart.title": "Start Core at sign-in",
    "settings.autostart.desc": "Register Core to start with your Windows account so application policies stay live.",
    "settings.autostart.on": "Core will start automatically at sign-in.",
    "settings.autostart.off": "Core will not start automatically at sign-in.",
    "settings.autostart.ariaOn": "Disable Core autostart",
    "settings.autostart.ariaOff": "Enable Core autostart",

    "logs.eyebrow": "Audit trail",
    "logs.title": "Logs",
    "logs.desc": "Query recorded Core, runtime, and plugin events. Results do not update automatically.",
    "logs.scopeAria": "Log application scope",
    "logs.scope.label": "Scope",
    "logs.scope.all": "All applications",
    "logs.scope.selected": "Selected application",
    "logs.streamAria": "Log stream",
    "logs.stream.label": "Stream",
    "logs.stream.all": "All streams",
    "logs.stream.core": "Core",
    "logs.stream.runtime": "Runtime",
    "logs.stream.plugin": "Plugin",
    "logs.loading.title": "Querying latest events",
    "logs.loading.desc": "Fetching the newest 20 {scope} events from Core.",
    "logs.error.title": "Couldn’t query logs",
    "logs.noEvents.title": "No matching events",
    "logs.noEvents.desc": "Core returned no {scope} events for this query.",
    "logs.loadingOlder": "Loading older events…",
    "logs.oldest": "You’ve reached the oldest event in this query.",
    "logs.results.ready": "Ready to query",
    "logs.results.one": "{count} event",
    "logs.results.many": "{count} events",
    "logs.queryDetails": "Query details",
    "logs.readOnlyTitle": "Read-only history",
    "logs.guide.latest.title": "Latest first",
    "logs.guide.latest.desc": "Each refresh asks Core for the newest 20 matching events.",
    "logs.guide.scoped.title": "Scoped results",
    "logs.guide.scoped.desc": "Filter to the selected application or keep the query across all applications.",
    "logs.guide.nolive.title": "No live feed",
    "logs.guide.nolive.desc": "New activity appears after an explicit refresh.",
    "logs.appContext": "App · {name}",
    "logs.pluginContext": "Plugin · {name}",

    "msg.launched": "Launched with extensions.",
    "msg.pluginInstalled": "Plugin installed. Review its requested capabilities before enabling it.",
    "msg.pluginInstallCanceled": "No plugin was selected. Installation was canceled.",
    "msg.applicationRegistered": "Application registered. Its policy scope is ready to review.",
    "msg.applicationRegisterCanceled": "No executable was selected. Application registration was canceled.",
    "msg.developerModeOn": "Developer mode enabled.",
    "msg.developerModeOff": "Developer mode disabled.",
    "msg.pluginPolicyUpdated": "Plugin policy updated.",
    "msg.pluginSettingsUpdated": "Plugin settings updated.",
    "msg.pluginRemoved": "Plugin removed from Core.",
    "msg.autostartOn": "Core autostart enabled.",
    "msg.autostartOff": "Core autostart disabled.",
    "msg.applicationRemoved": "Application removed. Its registration and policies were removed.",

    "dialog.add.eyebrow": "New policy scope",
    "dialog.add.title": "Add an application",
    "dialog.add.closeAria": "Close add application dialog",
    "dialog.add.desc": "Choose the support level for this executable. Continue to select the executable in the native picker.",
    "dialog.add.supportLevel": "Support level",
    "dialog.add.level0": "Level 0 — Register without plugin support",
    "dialog.add.level1": "Level 1 — Renderer integration",
    "dialog.add.level2": "Level 2 — Electron integration",
    "dialog.add.cancel": "Cancel",
    "dialog.add.chooseExec": "Choose executable",
    "dialog.remove.eyebrow": "Remove plugin",
    "dialog.remove.title": "Remove plugin?",
    "dialog.remove.titleNamed": "Remove {name}?",
    "dialog.remove.titleFallback": "plugin",
    "dialog.remove.copy": "This removes the installed package and its application policies from Core.",
    "dialog.remove.keep": "Keep plugin",
    "dialog.remove.confirm": "Remove plugin",
    "dialog.removeApp.title": "Remove application?",
    "dialog.removeApp.titleNamed": "Remove {name}?",
    "dialog.removeApp.titleFallback": "application",
    "dialog.removeApp.copy": "This removes only this application’s registration and its policies from Core. Other applications and installed plugin data are unaffected.",
    "dialog.removeApp.keep": "Keep application",
    "dialog.removeApp.confirm": "Remove application",
    "dialog.removeApp.cancel": "Cancel",
  },

  zh: {
    "app.title": "TronHawk 管理器",

    "error.generic": "Core 未完成请求。",

    "common.dismiss": "忽略",
    "common.tryAgain": "重试",
    "common.cancel": "取消",

    "nav.group.workspace": "工作区",
    "nav.group.system": "系统",
    "nav.aria": "管理器版块",
    "nav.applications": "应用",
    "nav.plugins": "插件",
    "nav.permissions": "权限",
    "nav.logs": "日志",
    "nav.settings": "设置",

    "sidebar.footer.title": "核心控制平面",
    "sidebar.footer.desc": "策略以所选应用为作用域，并通过 Core 保存。",

    "notice.connected.title": "已连接到 Core。",
    "notice.connected.desc": "此处展示的应用策略反映 Manager 最新的快照。",

    "loading.aria": "加载中",
    "loading.title": "正在加载 Core 快照",
    "loading.desc": "读取已注册的应用与已安装的插件策略。",

    "failure.title": "无法连接到 Core",
    "failure.desc": "无法加载 Manager 快照。",

    "level.0": "级别 0 · 不支持",
    "level.1": "级别 1 · 渲染器",
    "level.2": "级别 2 · Electron",

    "action.install": "＋ 安装插件",
    "action.addApplication": "＋ 添加应用",
    "action.addApplicationPlain": "添加应用",
    "action.launch": "启动",
    "action.launch.withExtensions": "以扩展启动 {name}",
    "action.refresh": "↻ 刷新",
    "action.loadOlder": "加载更早",
    "action.viewLogs": "查看日志状态",
    "action.removeApp": "移除应用",

    "context.aria": "选定应用的策略",
    "context.label": "策略作用域",
    "context.currentApplication": "当前应用",
    "context.registeredExecutable": "已注册的本地可执行程序",
    "context.selectAria": "当前应用策略",

    "summary.connection": "连接状态",
    "summary.connectedValue": "Core 已连接",
    "summary.connectedFor": "当前显示 {name} 的策略。",
    "summary.connectedEmpty": "添加一个应用后即可设置插件策略。",
    "summary.applications": "应用",
    "summary.applicationsDetail": "已在 Core 注册",
    "summary.enabledHere": "在此处启用",
    "summary.enabledFor": "此应用的策略",
    "summary.enabledChoose": "选择一个应用以查看策略",

    "applications.eyebrow": "概览",
    "applications.title": "你的扩展工作区",
    "applications.desc": "管理已安装的插件与应用作用域的 Core 策略。",
    "applications.panelTitle": "应用",
    "applications.chooseScope": "选择策略作用域",
    "applications.startWithExecutable": "从一个已注册的可执行程序开始",
    "applications.coreActivity": "Core 活动",
    "applications.activityTitle": "等待 Core 摄取",
    "applications.activityDesc": "活动未包含在 Manager 快照中。",

    "empty.addFirst.title": "添加你的第一个应用",
    "empty.addFirst.desc": "选择支持级别，然后在系统原生选择器中选择一个可执行程序。Core 会把它注册为一个策略作用域。",
    "empty.needApp.title": "请先添加应用",
    "empty.needApp.desc": "选择支持级别，然后在系统原生选择器中选择一个可执行程序，以创建 Core 策略作用域。",

    "appcard.registeredExecutable": "已注册的本地可执行程序",
    "appcard.enabled": "已启用 {count}",
    "appcard.selectAria": "选择 {name} 作为策略作用域",
    "appcard.launchHelp.disabled": "级别 0 的应用无法以扩展启动",
    "appcard.remove": "移除 {name}",
    "appcard.removeAria": "从工作区移除 {name}",

    "iefo.title": "透明启动（IFEO）",
    "iefo.detail": "启用后，在管理器之外双击该应用将经由 TronHawk 启动，并应用其策略。",
    "iefo.on": "透明启动已开启，外部双击将经由 TronHawk。",
    "iefo.off": "透明启动已关闭，外部双击将直接启动该应用。",
    "iefo.loading": "正在读取透明启动状态…",
    "iefo.ownedNote": "该应用的启动登记归属其它程序，TronHawk 无法在此管理。",
    "iefo.toggleOn": "为 {name} 关闭透明启动",
    "iefo.toggleOff": "为 {name} 开启透明启动",
    "iefo.notice.enabled": "已启用透明启动，外部双击将通过 TronHawk 运行。",
    "iefo.notice.disabled": "已关闭透明启动，外部双击将直接启动应用。",
    "iefo.notice.cancelled": "已取消提权，透明启动设置未更改。",

    "plugins.eyebrow": "已安装的包",
    "plugins.title": "插件",
    "plugins.desc": "每个开关都会在 Core 中更新当前应用的完整策略。",
    "plugins.descEmpty": "先添加一个应用，再来设置插件策略。",
    "plugins.filterAria": "筛选插件",
    "plugins.filter.all": "全部",
    "plugins.filter.enabled": "已启用",
    "plugins.filter.disabled": "已禁用",
    "plugins.summary": "共 {total} 个包，已显示 {shown} 个 · {application}",
    "plugins.noApplicationName": "未选择应用",
    "plugins.noneForFilter": "此应用没有{filter}插件",
    "plugins.noPluginsTitle": "尚未安装插件",
    "plugins.noneForFilter.desc": "安装一个 .thx 包，或选择其他策略作用域。",

    "plugin.author": "作者：{author} · 需要 TronHawk {version}",
    "plugin.policyOne": "{count} 个应用策略",
    "plugin.policyOther": "{count} 个应用策略",
    "plugin.permissions": "权限",
    "plugin.removeAria": "移除 {name}",
    "plugin.toggle.enableFor": "为所选应用启用 {name}",
    "plugin.toggle.disableFor": "为所选应用禁用 {name}",
    "plugin.toggle.disabled": "级别 0 的应用无法启用插件",

    "permissions.eyebrow": "安全审查",
    "permissions.title": "权限",
    "permissions.desc": "授权属于所选应用的策略，并通过 Core 保存。",
    "permissions.descEmpty": "先添加一个应用，再来审查应用作用域的授权。",
    "permissions.descNoPlugins": "审查每个已安装包所申请的能力。",
    "permissions.installedPlugins": "已安装插件",
    "permissions.enabledFor": "已为 {application} 启用",
    "permissions.disabledFor": "已为 {application} 禁用",
    "permissions.requestedCaps": "申请的能力",
    "permissions.noCaps": "此包未申请任何能力。",
    "permissions.note": "仅能授予{level}下可用的能力。授权更改会保留此插件其余的策略。",
    "permissions.policyVersion": "{application} 策略 · v{version}",
    "permissions.noPlugins.title": "没有可审查的插件",
    "permissions.noPlugins.desc": "已安装的包会显示在这里。",

    "permission.granted": "已授予",
    "permission.withheld": "已保留",
    "permission.unavailable": "此处不可用",
    "permission.risk": "{risk}风险",
    "permission.risk.low": "低",
    "permission.risk.medium": "中",
    "permission.risk.high": "高",
    "permission.risk.unknown": "未知",
    "permission.grantAria": "为所选应用授予 {permission}",
    "permission.revokeAria": "为所选应用撤回 {permission}",

    "perm.renderer.css": "允许将插件的渲染器 CSS 应用到页面。",
    "perm.renderer.script": "允许插件的渲染器脚本运行。",
    "perm.electron.window": "允许插件操作受管理的应用窗口。",
    "perm.runtime.unsafe": "在目标应用中授予原始 Node.js + Electron —— 可执行任意代码，仅开发者模式生效。",
    "perm.default": "由该插件申请。",

    "config.pluginSettings": "插件设置",
    "config.fieldType": "{type} 字段",
    "config.turnOn": "开启",
    "config.turnOff": "关闭",
    "config.on": "开",
    "config.off": "关",
    "config.toggleAria": "为所选应用{action}{label}",
    "config.fieldAria": "为所选应用的 {label}（{type}）",
    "config.storedIn": "设置按应用独立存储，并结合进 {name} 的启动计划。更改后会在几秒内更新正在运行的插件，运行时将按新的计划重新加载它。",

    "settings.eyebrow": "管理器设置",
    "settings.title": "设置",
    "settings.desc": "这些控制平面选项决定 Core 可向已安装插件授予哪些能力。",
    "settings.devMode.title": "开发者模式",
    "settings.devMode.desc": "解锁 Core 对普通插件策略保留的能力。",
    "settings.devMode.toggleOn": "开发者模式已开启，点击可关闭。",
    "settings.devMode.toggleOff": "开发者模式已关闭，点击可开启。",
    "settings.devMode.ariaOn": "关闭开发者模式",
    "settings.devMode.ariaOff": "开启开发者模式",
    "settings.devMode.warning": "被授予 runtime.unsafe 的插件将在目标应用中拥有完整的 Node/Electron 访问权限，可读取文件、访问网络、读取应用数据，甚至终止应用。请只为你编写或完全信任的插件开启。",
    "settings.devMode.explain": "开发者模式将最强大的插件权限置于明确的抉择之下。除非需要为你编写或完全信任的插件授予 runtime.unsafe，否则请保持关闭。",
    "settings.devMode.offNote": "当开发者模式关闭时，runtime.unsafe 不属于任何应用的可用能力，因此 Core 不会为其应用新的授权。",
    "settings.guide.node.title": "Node.js + Electron",
    "settings.guide.node.desc": "runtime.unsafe 是 SDK 最强的能力：被授予的插件可在目标应用内以完整的进程权限运行。",
    "settings.guide.l2.title": "2 级应用",
    "settings.guide.l2.desc": "当开发者模式开启时，权限视图会将 runtime.unsafe 列为可授予 2 级应用的能力。",
    "settings.guide.reversible.title": "可逆",
    "settings.guide.reversible.desc": "关闭开发者模式会将 runtime.unsafe 移出可授予集合，已有的应用策略保持不变。",
    "settings.system.title": "系统",
    "settings.system.desc": "由管理器维护的界面与启动偏好。",
    "settings.language.title": "语言",
    "settings.language.desc": "选择界面语言。",
    "settings.language.optionEn": "English",
    "settings.language.optionZh": "中文",
    "settings.autostart.title": "登录时启动 Core",
    "settings.autostart.desc": "注册 Core 随你的 Windows 账户启动，使应用策略保持生效。",
    "settings.autostart.on": "Core 将在登录时自动启动。",
    "settings.autostart.off": "Core 不会在登录时自动启动。",
    "settings.autostart.ariaOn": "关闭 Core 自动启动",
    "settings.autostart.ariaOff": "开启 Core 自动启动",

    "logs.eyebrow": "审计轨迹",
    "logs.title": "日志",
    "logs.desc": "查询已记录的 Core、运行时与插件事件，结果不会自动刷新。",
    "logs.scopeAria": "日志应用作用域",
    "logs.scope.label": "作用域",
    "logs.scope.all": "所有应用",
    "logs.scope.selected": "所选应用",
    "logs.streamAria": "日志流",
    "logs.stream.label": "流",
    "logs.stream.all": "所有流",
    "logs.stream.core": "Core",
    "logs.stream.runtime": "运行时",
    "logs.stream.plugin": "插件",
    "logs.loading.title": "正在查询最新事件",
    "logs.loading.desc": "正在从 Core 获取最新的 20 条{scope}事件。",
    "logs.error.title": "无法查询日志",
    "logs.noEvents.title": "没有匹配的事件",
    "logs.noEvents.desc": "Core 未返回与此查询匹配的{scope}事件。",
    "logs.loadingOlder": "正在加载更早的事件…",
    "logs.oldest": "已到达此查询中最早的事件。",
    "logs.results.ready": "准备就绪，可查询",
    "logs.results.one": "{count} 条事件",
    "logs.results.many": "{count} 条事件",
    "logs.queryDetails": "查询明细",
    "logs.readOnlyTitle": "只读历史",
    "logs.guide.latest.title": "最新优先",
    "logs.guide.latest.desc": "每次刷新都会向 Core 请求最新的 20 条匹配事件。",
    "logs.guide.scoped.title": "作用域结果",
    "logs.guide.scoped.desc": "可筛选到所选应用，或跨所有应用查询。",
    "logs.guide.nolive.title": "无实时推送",
    "logs.guide.nolive.desc": "新活动会在手动刷新后出现。",
    "logs.appContext": "应用 · {name}",
    "logs.pluginContext": "插件 · {name}",

    "msg.launched": "已通过扩展启动。",
    "msg.pluginInstalled": "插件已安装。启用前请审查其申请的能力。",
    "msg.pluginInstallCanceled": "未选择插件，安装已取消。",
    "msg.applicationRegistered": "应用已注册，其策略作用域已可审查。",
    "msg.applicationRegisterCanceled": "未选择可执行程序，应用注册已取消。",
    "msg.developerModeOn": "开发者模式已开启。",
    "msg.developerModeOff": "开发者模式已关闭。",
    "msg.pluginPolicyUpdated": "插件策略已更新。",
    "msg.pluginSettingsUpdated": "插件设置已更新。",
    "msg.pluginRemoved": "插件已从 Core 中移除。",
    "msg.autostartOn": "Core 自动启动已开启。",
    "msg.autostartOff": "Core 自动启动已关闭。",
    "msg.applicationRemoved": "应用已移除，其登记与策略已删除。",

    "dialog.add.eyebrow": "新的策略作用域",
    "dialog.add.title": "添加应用",
    "dialog.add.closeAria": "关闭添加应用对话框",
    "dialog.add.desc": "为此可执行程序选择支持级别。随后将在系统原生选择器中选择该可执行程序。",
    "dialog.add.supportLevel": "支持级别",
    "dialog.add.level0": "级别 0 —— 注册但不支持插件",
    "dialog.add.level1": "级别 1 —— 渲染器集成",
    "dialog.add.level2": "级别 2 —— Electron 集成",
    "dialog.add.cancel": "取消",
    "dialog.add.chooseExec": "选择可执行程序",
    "dialog.remove.eyebrow": "移除插件",
    "dialog.remove.title": "移除插件？",
    "dialog.remove.titleNamed": "移除 {name}？",
    "dialog.remove.titleFallback": "插件",
    "dialog.remove.copy": "这将从 Core 移除该已安装包及其应用策略。",
    "dialog.remove.keep": "保留插件",
    "dialog.remove.confirm": "移除插件",
    "dialog.removeApp.title": "移除应用？",
    "dialog.removeApp.titleNamed": "移除 {name}？",
    "dialog.removeApp.titleFallback": "应用",
    "dialog.removeApp.copy": "这只会从 Core 移除该应用的登记与其策略，不影响其它应用与已安装插件的数据。",
    "dialog.removeApp.keep": "保留应用",
    "dialog.removeApp.confirm": "移除应用",
    "dialog.removeApp.cancel": "取消",
  },
};

let currentLanguage = detectLanguage();

function detectLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // localStorage may be unavailable (e.g. some webviews); fall through to the browser locale.
  }
  const nav = String(
    (typeof navigator !== "undefined" && (navigator.language || (navigator.languages && navigator.languages[0]))) || "en",
  ).toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

/** Translate a key, substituting `{name}` placeholders from an object or `{0}`/`{1}` positionally. */
export function t(key, ...args) {
  const dict = dictionaries[currentLanguage] || dictionaries.en;
  let text = dict[key] ?? dictionaries.en[key] ?? key;
  if (args.length === 1 && args[0] !== null && typeof args[0] === "object") {
    text = text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(args[0], name) ? String(args[0][name]) : match));
  } else if (args.length) {
    text = text.replace(/\{(\d+)\}/g, (match, index) => (args[Number(index)] !== undefined ? String(args[Number(index)]) : match));
  }
  return text;
}

export function getLanguage() {
  return currentLanguage;
}

export function setLanguage(lang) {
  const next = lang === "zh" ? "zh" : "en";
  if (next === currentLanguage && localStorage.getItem(STORAGE_KEY) === next) {
    applyToDocument();
    return currentLanguage;
  }
  currentLanguage = next;
  try {
    localStorage.setItem(STORAGE_KEY, currentLanguage);
  } catch {
    // Ignore write failures; the language still applies for this session.
  }
  applyToDocument();
  return currentLanguage;
}

function applyToDocument() {
  document.documentElement.lang = currentLanguage;
  const titleEl = document.querySelector("title");
  if (titleEl) titleEl.textContent = t("app.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (!key) return;
    const value = t(key);
    if (value === key) return;
    if (el.dataset.i18nAttr) {
      el.setAttribute(el.dataset.i18nAttr, value);
    } else {
      el.textContent = value;
    }
  });
}

applyToDocument();
