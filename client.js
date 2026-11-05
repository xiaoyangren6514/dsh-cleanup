/**
 * dsh-cleanup — browser half.
 *
 * Classic browser script loaded by the Harness module loader. It owns:
 *   - the review dialog (`shell.overlay` for the context menus, plus an in-sheet copy that the
 *     settings page renders so its own deletions never dismiss the settings sheet),
 *   - the storage-cleanup settings page (`settings.section`),
 *   - two dangerous context-menu actions and their trash glyph,
 *   - its own `cleanup` locale namespace (zh + en, identical key sets),
 *   - its own stylesheet (`<style>` owned and removed on dispose).
 *
 * Only `require('react')` is used. No JSX, no build step, no @deepseek-ai imports.
 * The HTTP contract is the frozen one in SPEC.md §4; ids/slot names/orders are
 * frozen by SPEC.md §7. The UI never deletes on a single click: every destructive
 * request is preceded by a plan the user reviews, blockers disable the button,
 * and permanent deletion of a workspace directory additionally requires typing
 * the folder name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cleanup',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useEffect, useId, useRef, useState, useSyncExternalStore } = React

    const NS = 'cleanup'

    /** Frozen document-relative routes (SPEC §8). `fetch` takes no leading slash. */
    const ROUTE = {
      inventory: '/api/cleanup.inventory'.slice(1),
      measure: '/api/cleanup.measure'.slice(1),
      plan: '/api/cleanup.plan'.slice(1),
      delete: '/api/cleanup.delete'.slice(1),
      trashList: '/api/cleanup.trash.list'.slice(1),
      trashRestore: '/api/cleanup.trash.restore'.slice(1),
      trashPurge: '/api/cleanup.trash.purge'.slice(1),
      defer: '/api/cleanup.defer'.slice(1),
      deferredList: '/api/cleanup.deferred.list'.slice(1),
      deferredCancel: '/api/cleanup.deferred.cancel'.slice(1),
      deferredRequeue: '/api/cleanup.deferred.requeue'.slice(1),
      settingsGet: '/api/cleanup.settings.get'.slice(1),
      settingsSet: '/api/cleanup.settings.set'.slice(1),
      candidates: '/api/cleanup.candidates'.slice(1),
    }

    /** How long a successful result stays on screen before the dialog closes itself. */
    const DONE_VISIBLE_MS = 3200
    /** Ignore a confirming second activation for this long so a double click cannot purge. */
    const CONFIRM_COOLDOWN_MS = 400
    /** UI-only page cap while the Host list may hold up to 2000 sessions. */
    const SESSION_PAGE_SIZE = 300
    /** Workspace filter values for the Sessions tab (`''` = every Session). */
    const SESSION_WORKSPACE_ANY = ''
    const SESSION_WORKSPACE_UNGROUPED = '__ungrouped__'
    /** Max queued targets rendered per deferred entry before "and N more". */
    const DEFERRED_TARGETS_MAX = 4
    /** Cleanup-wizard preview cap (SPEC §4.9 limit) and the plan's target cap. */
    const WIZARD_PREVIEW_LIMIT = 100
    const WIZARD_TARGET_MAX = 64
    /**
     * "Clear workspace sessions" runs through ordinary plans, and one plan holds at most 64
     * targets (Host §4.3), so the clear walks the workspace in batches of this size. A page of
     * candidates is the Host's §4.9 maximum; the clear refills from the next page when a page is
     * exhausted, and stops after CLEAR_MAX_ROUNDS pages as a safety net.
     */
    const CLEAR_BATCH_TARGETS = 64
    const CLEAR_CANDIDATE_LIMIT = 500
    const CLEAR_MAX_ROUNDS = 40
    /**
     * A clear re-reads the workspace when a batch plan hits a target that vanished outside this
     * run (`UNKNOWN_SESSION`). The bound keeps a misbehaving/looping Host from walking forever.
     */
    const CLEAR_RESYNC_MAX = 2
    /** Debounce before re-asking the Host for candidate rows. */
    const WIZARD_DEBOUNCE_MS = 300
    /** Client-side bounds mirroring SPEC §4.9. */
    const WIZARD_MAX_OLDER_DAYS = 3650
    const WIZARD_MAX_MIN_BYTES = 1000000000000000
    /**
     * Blocker codes that a restart clears: DSH keeps an opened Agent (and its
     * session write handle) for the whole process lifetime, so these are safe to
     * queue for the next start. Any other blocker survives a restart, so queueing
     * would only fail again and must not be offered.
     */
    const DEFERRABLE_BLOCKER_CODES = { SESSION_LIVE: true, SESSION_RUNNING: true, WORKSPACE_HAS_LIVE_SESSIONS: true }
    /** `inventory.audit.recent` is capped at 10 by the Host; render at most that many. */
    const AUDIT_RECENT_MAX = 10
    /** The one-time "last start processed something" notice covers this recent a start. */
    const AUDIT_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000
    /** localStorage key holding the acknowledged startup timestamp (guarded everywhere). */
    const AUDIT_NOTICE_STORAGE_KEY = 'dsh-cleanup.auditStartupAck'
    /** One mebibyte; byte-valued settings are edited in MB. */
    const BYTES_PER_MB = 1024 * 1024
    /**
     * Client-side bounds for the editable settings (SPEC §4.8). The Host validates the
     * same ranges; checking here keeps an invalid value from ever leaving the browser.
     */
    const SETTINGS_NUMERIC_BOUNDS = {
      maxScanEntries: { min: 1, max: 5000000, integer: true },
      scanTimeoutMs: { min: 1, max: 600000, integer: true },
      planTtlMs: { min: 1000, max: 86400000, integer: true },
      maxPlans: { min: 1, max: 1000, integer: true },
      auditMaxBytes: { min: 0, max: 1073741824, integer: true },
      trashRetentionDays: { min: 0, max: 3650, integer: true },
      trashMaxBytes: { min: 0, max: 1000000000000000, integer: true },
    }
    /** Editable settings in display order; `trashRoot` is read-only and not saved. */
    const SETTINGS_BOOLEAN_FIELDS = ['allowPermanentDeletion', 'auditEnabled', 'gitSafetyCheck']
    const SETTINGS_ADVANCED_FIELDS = ['maxScanEntries', 'scanTimeoutMs', 'planTtlMs', 'maxPlans']

    // ------------------------------------------------------------------ copy

    const zh = {
      'section.label': '存储清理',
      'page.title': '存储清理',
      'page.intro': '删除工作区目录或会话记录前先预览影响范围；默认移入可恢复的回收站。',
      'page.refresh': '刷新',
      'page.measure': '测量大小',
      'page.footer.note': '回收站不会自动清理，可随时恢复；彻底删除无法撤销。',
      'page.truncated': '会话数量已达上限，列表只显示了一部分。',
      'page.truncated.cap': '会话数量已达上限（{count} 条），列表只显示了一部分。',
      'page.loading': '正在加载…',
      'page.error': '加载失败',
      'page.empty.workspaces': '还没有已注册的工作区。',
      'page.empty.sessions': '还没有会话记录。',
      'page.empty.sessionsFiltered': '没有符合当前筛选条件的会话。',
      'page.empty.trash': '回收站是空的。',
      'page.select': '选择',
      'page.selectedCount_one': '已选择 {count} 项',
      'page.selectedCount_other': '已选择 {count} 项',
      'page.showMore_one': '显示更多（还有 {count} 项）',
      'page.showMore_other': '显示更多（还有 {count} 项）',
      'tab.workspaces': '工作区',
      'tab.sessions': '会话',
      'tab.trash': '回收站',
      'tab.settings': '清理设置',
      'settings.group.deletion': '删除权限',
      'settings.group.trash': '回收站',
      'settings.group.audit': '审计日志',
      'settings.group.advanced': '高级',
      'settings.field.allowPermanentDeletion': '允许永久删除',
      'settings.field.allowPermanentDeletionHint': '关闭后只能把目标移入回收站',
      'settings.field.trashRetentionDays': '回收站保留天数',
      'settings.field.trashRetentionDaysHint': '最旧条目超过该天数时提示清理；0 = 关闭提醒',
      'settings.field.trashMaxBytes': '回收站大小上限（MB）',
      'settings.field.trashMaxBytesHint': '超过该大小时提示清理；0 = 关闭提醒',
      'settings.field.auditEnabled': '记录删除审计日志',
      'settings.field.auditEnabledHint': '记录删除、跳过、恢复、清空与队列操作',
      'settings.field.auditMaxBytes': '审计日志大小上限（MB）',
      'settings.field.auditMaxBytesHint': '超过后轮换为 audit.jsonl.1；0 = 不轮换',
      'settings.field.maxScanEntries': '扫描条目上限',
      'settings.field.maxScanEntriesHint': '单次目录扫描最多处理的条目数',
      'settings.field.scanTimeoutMs': '扫描超时（毫秒）',
      'settings.field.scanTimeoutMsHint': '单次目录扫描的时间上限',
      'settings.field.planTtlMs': '检查结果有效期（毫秒）',
      'settings.field.planTtlMsHint': '删除计划创建后多长时间内有效',
      'settings.field.maxPlans': '保留的检查结果数',
      'settings.field.maxPlansHint': '超出后最早的检查结果会被丢弃',
      'settings.field.trashRoot': '回收站位置',
      'settings.field.trashRootHint': '修改后已有回收站条目会留在旧位置，不会迁移',
      'settings.field.notEditable': '只读',
      'settings.field.gitSafetyCheck': '检查 Git 未提交/未推送内容',
      'settings.field.gitSafetyCheckHint': '删除工作区目录前只读检查 git 状态；只会警告，不会阻止删除',
      'settings.reset': '重置为默认值',
      'settings.resetHint': '点击“保存”后生效',
      'settings.save': '保存',
      'settings.unchanged': '没有需要保存的修改',
      'settings.notWritable': '设置文件当前不可写，修改只会在本次运行生效',
      'settings.saving': '正在保存…',
      'settings.saved': '已保存',
      'settings.savedVolatile': '已保存，仅本次运行生效（无法写入设置文件）',
      'settings.persistError': '写入设置文件失败：{message}',
      'settings.error.number': '{label}必须是数字',
      'settings.error.integer': '{label}必须是整数',
      'settings.error.range': '{label}必须在 {min} 到 {max} 之间',
      'settings.error.saveFailed': '保存失败，请重试',
      'trash.retention.title': '回收站超过建议上限',
      'trash.retention.capacity': '当前占用 {size}，超过上限 {max}',
      'trash.retention.capacityGeneric': '当前占用 {size}，超过配置的大小上限',
      'trash.retention.age_one': '最旧条目已保留 {days} 天，超过保留期 {maxDays} 天',
      'trash.retention.age_other': '最旧条目已保留 {days} 天，超过保留期 {maxDays} 天',
      'trash.retention.ageGeneric_one': '最旧条目已保留 {days} 天，超过保留期提醒阈值',
      'trash.retention.ageGeneric_other': '最旧条目已保留 {days} 天，超过保留期提醒阈值',
      'trash.retention.note': '插件不会自动删除任何条目；可以手动清理最旧条目，或选择条目“彻底删除”。',
      'trash.retention.manual': '没有可直接建议清理的条目，请手动选择“彻底删除”。',
      'trash.retention.purgeSuggested_one': '清理最旧条目（{count} 项）',
      'trash.retention.purgeSuggested_other': '清理最旧条目（{count} 项）',
      'trash.retention.armed_one': '已选择清理最旧 {count} 项，再次点击确认',
      'trash.retention.armed_other': '已选择清理最旧 {count} 项，再次点击确认',
      'deferred.retained.title': '上次未完成',
      'deferred.retained.empty': '没有未完成的条目。',
      'deferred.retainedNotice_one': '另有 {count} 项上次未完成',
      'deferred.retainedNotice_other': '另有 {count} 项上次未完成',
      'deferred.retainedAt': '处理于 {time}',
      'deferred.retained.requeue': '重新安排',
      'deferred.retained.requeueConfirm': '确认重新安排',
      'deferred.retained.forget': '忽略',
      'deferred.retained.forgetConfirm': '确认忽略',
      'deferred.retained.requeueArmed': '已选择重新安排该条目，再次点击确认',
      'deferred.retained.forgetArmed': '已选择忽略该条目，再次点击确认',
      'deferred.retained.requeued_one': '已重新安排 {count} 项',
      'deferred.retained.requeued_other': '已重新安排 {count} 项',
      'deferred.retained.forgotten_one': '已忽略 {count} 项',
      'deferred.retained.forgotten_other': '已忽略 {count} 项',
      'audit.title': '最近删除',
      'audit.empty': '还没有删除记录。',
      'audit.lastStartup': '上次启动处理（{time}）：已应用 {applied} · 跳过 {skipped} · 失败 {failed}',
      'audit.source.startup': '启动时',
      'audit.source.immediate': '手动',
      'audit.action.delete': '删除',
      'audit.action.skip': '跳过',
      'audit.action.defer': '安排删除',
      'audit.action.requeue': '重新安排',
      'audit.action.cancel': '取消队列',
      'audit.action.restore': '恢复',
      'audit.action.purge': '清空',
      'audit.action.startupRun': '启动处理',
      'audit.action.unknown': '操作',
      'audit.status.trashed': '已移入回收站',
      'audit.status.deleted': '已删除',
      'audit.status.failed': '失败',
      'audit.status.skipped': '已跳过',
      'audit.status.queued': '已排队',
      'audit.status.requeued': '已重新安排',
      'audit.status.cancelled': '已取消',
      'audit.status.done': '完成',
      'audit.status.restored': '已恢复',
      'audit.status.purged': '已清空',
      'audit.status.unknown': '未知状态',
      'audit.notice.title': '上次启动的处理结果',
      'audit.notice.body': '已应用 {applied} · 跳过 {skipped} · 失败 {failed}',
      'audit.notice.link': '查看清理设置',
      'audit.notice.dismiss': '知道了',
      'measure.button': '测量',
      'measure.measuring': '测量中…',
      'measure.unmeasured': '未测量',
      'measure.truncated': '统计达到扫描上限，实际大小更大',
      'count.file_one': '{count} 个文件',
      'count.file_other': '{count} 个文件',
      'count.dir_one': '{count} 个目录',
      'count.dir_other': '{count} 个目录',
      'workspace.sessions_one': '{count} 个会话',
      'workspace.sessions_other': '{count} 个会话',
      'badge.missing': '缺失',
      'badge.unsafe': '不安全',
      'badge.running': '运行中',
      'badge.live': '已打开',
      'badge.archived': '归档',
      'badge.subagent': '子代理',
      'badge.notDeletable': '不可删除',
      'session.untitled': '未命名会话',
      'action.delete': '删除…',
      'action.deleteSelected_one': '删除选中 ({count})',
      'action.deleteSelected_other': '删除选中 ({count})',
      'action.clearSelection': '取消选择',
      'action.restore': '恢复',
      'action.purge': '彻底删除',
      'action.purgeConfirm': '确认彻底删除',
      'action.emptyTrash': '清空回收站',
      'action.emptyTrashConfirm': '确认清空回收站',
      'action.cancel': '取消',
      'action.retry': '重试',
      'action.close': '关闭',
      'action.done': '完成',
      'a11y.rowAction': '{action}：{title}',
      'trash.summary_one': '共 {count} 项 · {size}',
      'trash.summary_other': '共 {count} 项 · {size}',
      'trash.movedAt': '移入时间',
      'trash.parentSession': '父会话 {id}',
      'trash.restoreUnavailable': '无法恢复',
      'trash.purgeArmed': '已进入确认状态：再次激活将永久删除“{title}”，此操作不可撤销。',
      'trash.purgeAllArmed': '已进入确认状态：再次激活将永久清空回收站，此操作不可撤销。',
      'trash.announce.restored': '已从回收站恢复：{title}',
      'trash.announce.purged_one': '已从回收站永久删除 {count} 项。',
      'trash.announce.purged_other': '已从回收站永久删除 {count} 项。',
      'deferred.section': '待删除安排',
      'deferred.notice_one': '{count} 个待删除安排 · 下次启动 DSH 时自动执行',
      'deferred.notice_other': '{count} 个待删除安排 · 下次启动 DSH 时自动执行',
      'deferred.show': '查看',
      'deferred.hide': '收起',
      'deferred.cancelAll': '全部取消',
      'deferred.cancelAllConfirm': '确认全部取消',
      'deferred.cancelConfirm': '确认取消',
      'deferred.cancelArmed': '已进入确认状态：再次激活将取消该待删除安排。',
      'deferred.cancelAllArmed': '已进入确认状态：再次激活将取消全部待删除安排。',
      'deferred.cancelled_one': '已取消 {count} 个待删除安排。',
      'deferred.cancelled_other': '已取消 {count} 个待删除安排。',
      'deferred.entryTitle_one': '{count} 个目标',
      'deferred.entryTitle_other': '{count} 个目标',
      'deferred.workspaceTarget': '工作区 {id}',
      'deferred.moreTargets_one': '另有 {count} 个目标',
      'deferred.moreTargets_other': '另有 {count} 个目标',
      'deferred.queuedAt': '安排于 {time}',
      'deferred.mode': '删除方式：{mode}',
      'deferred.listTargets_one': '共 {count} 个目标',
      'deferred.listTargets_other': '共 {count} 个目标',
      'deferred.lastRun_one': '上次启动已处理 {count} 个安排，共涉及 {items}',
      'deferred.lastRun_other': '上次启动已处理 {count} 个安排，共涉及 {items}',
      'deferred.lastRunItems_one': '{count} 个目标',
      'deferred.lastRunItems_other': '{count} 个目标',
      'deferred.lastRunSkipped_one': '{count} 个安排被跳过',
      'deferred.lastRunSkipped_other': '{count} 个安排被跳过',
      'deferred.lastRunFailed_one': '{count} 个安排失败',
      'deferred.lastRunFailed_other': '{count} 个安排失败',
      'deferred.showDetails': '查看未成功的记录',
      'deferred.hideDetails': '收起未成功的记录',
      'deferred.status.skipped': '已跳过',
      'deferred.status.failed': '失败',
      'deferred.status.trashed': '已移入回收站（部分失败）',
      'deferred.status.deleted': '已删除（部分失败）',
      'deferred.loading': '正在加载待删除安排…',
      'deferred.empty': '没有待删除安排。',
      'sessions.sort.label': '排序',
      'sessions.workspaceFilter': '工作区',
      'sessions.workspaceFilter.all': '全部工作区',
      'sessions.workspaceFilter.ungrouped': '未分组',
      'sessions.sort.newest': '最新更新',
      'sessions.sort.oldest': '最旧更新',
      'sessions.sort.largest': '已测量大小',
      'sessions.sort.largestHint': '按已测量的大小从大到小排序；未测量的会话排在最后。',
      'sessions.filter.label': '归档状态',
      'sessions.filter.all': '全部会话',
      'sessions.filter.archived': '仅归档会话',
      'sessions.filter.active': '隐藏归档会话',
      'sessions.wizard.action': '按规则选择',
      'sessions.wizard.close': '收起筛选规则',
      'sessions.wizard.title': '按规则选择会话',
      'sessions.wizard.legend': '筛选规则',
      'sessions.wizard.olderThanDays': '早于（天）',
      'sessions.wizard.olderThanDaysHint': '0 = 不限',
      'sessions.wizard.archived': '归档状态',
      'sessions.wizard.archived.all': '全部',
      'sessions.wizard.archived.only': '仅归档',
      'sessions.wizard.archived.exclude': '排除归档',
      'sessions.wizard.minBytes': '至少大小（MB）',
      'sessions.wizard.minBytesHint': '0 = 不限',
      'sessions.wizard.workspace': '工作区',
      'sessions.wizard.workspace.any': '任意工作区',
      'sessions.wizard.workspaceUnknown': '未知工作区',
      'sessions.wizard.origin': '来源',
      'sessions.wizard.origin.all': '全部',
      'sessions.wizard.origin.root': '根会话',
      'sessions.wizard.origin.subagent': '子代理',
      'sessions.wizard.requireDeletable': '只显示可直接删除的',
      'sessions.wizard.sort': '排序',
      'sessions.wizard.sort.oldest': '最旧优先',
      'sessions.wizard.sort.largest': '最大优先',
      'sessions.wizard.capNote': '最多预览 {limit} 项；复核计划最多包含 {max} 个目标',
      'sessions.wizard.idle': '调整规则后会预览匹配的会话',
      'sessions.wizard.loading': '正在筛选…',
      'sessions.wizard.error': '筛选失败',
      'sessions.wizard.empty': '没有符合规则的会话',
      'sessions.wizard.summary_one': '共 {count} 项 · 已知 {size}',
      'sessions.wizard.summary_other': '共 {count} 项 · 已知 {size}',
      'sessions.wizard.announce_one': '找到 {count} 个符合条件的会话 · 已知 {size}',
      'sessions.wizard.announce_other': '找到 {count} 个符合条件的会话 · 已知 {size}',
      'sessions.wizard.truncated': '已截断，仅显示前 {limit} 项',
      'sessions.wizard.lowerBound': '部分会话大小未知，合计是最小值',
      'sessions.wizard.selectAll': '全选可删除项（最多 {max} 项）',
      'sessions.wizard.selectedCount_one': '已选 {count} 项',
      'sessions.wizard.selectedCount_other': '已选 {count} 项',
      'sessions.wizard.capWarning_one': '共 {count} 项匹配，只有前 {max} 项会进入复核',
      'sessions.wizard.capWarning_other': '共 {count} 项匹配，只有前 {max} 项会进入复核',
      'sessions.wizard.selectCap': '最多选择 {max} 项',
      'sessions.wizard.review_one': '复核并删除（{count}）',
      'sessions.wizard.review_other': '复核并删除（{count}）',
      'sessions.wizard.age_one': '{days} 天前',
      'sessions.wizard.age_other': '{days} 天前',
      'common.none': '—',
      'common.working': '处理中…',
      'error.network': '网络请求失败，请检查连接后重试。',
      'error.badResponse': '服务器返回了无法解析的响应。',
      'error.unknown': '操作失败，请重试。',
      'error.CANCELLED': '请求已取消；剩余目标未处理。',
      'dialog.title.session': '删除会话',
      'dialog.title.workspace': '删除工作区目录',
      'dialog.title.mixed': '删除所选项目',
      'dialog.title.workspaceSessions': '清空工作区会话',
      'dialog.targets.count_one': '共 {count} 项',
      'dialog.targets.count_other': '共 {count} 项',
      'dialog.select.count_one': '已选择 {count} / {total} 项',
      'dialog.select.count_other': '已选择 {count} / {total} 项',
      'dialog.select.all': '全选',
      'dialog.select.invert': '反选',
      'dialog.select.required': '请至少选择一个目标',
      'dialog.select.excluded': '已取消选择，不会删除',
      'dialog.select.pending': '重新规划中…',
      'dialog.groups.show': '展开',
      'dialog.groups.hide': '收起',
      'dialog.groups.descendants_one': '{count} 个子代理会话',
      'dialog.groups.descendants_other': '{count} 个子代理会话',
      'dialog.groups.swept_one': '{count} 个目录内会话',
      'dialog.groups.swept_other': '{count} 个目录内会话',
      'dialog.planning': '正在检查…',
      'dialog.replanning': '正在重新检查…',
      'dialog.deleting': '正在删除…',
      'dialog.deleting.elapsed_one': '已用时 {seconds} 秒',
      'dialog.deleting.elapsed_other': '已用时 {seconds} 秒',
      'dialog.deleting.items_one': '正在删除 {count} 项',
      'dialog.deleting.items_other': '正在删除 {count} 项',
      'dialog.deleting.button_one': '删除中（{seconds} 秒）',
      'dialog.deleting.button_other': '删除中（{seconds} 秒）',
      'dialog.section.targets': '将删除以下内容',
      'dialog.section.warnings': '注意',
      'dialog.section.blockers': '无法删除',
      'dialog.mode.label': '删除方式',
      'dialog.mode.trash': '移入回收站（可恢复）',
      'dialog.mode.perm': '永久删除（不可恢复）',
      'dialog.mode.permDisabled': '当前配置已禁用永久删除',
      'dialog.mode.permMulti': '每份计划只能永久删除一个工作区目录；批量删除请选择回收站模式。',
      'dialog.mode.permAutoTrash': '永久删除一次只允许一个工作区目录；已自动改为移入回收站。',
      'dialog.mode.trashHint': '目标会移动到回收站，之后可在“存储清理 → 回收站”中恢复。',
      'dialog.mode.permHint': '永久删除不进入回收站，无法撤销，请确认已经备份。',
      'dialog.includeSessions': '同时删除该目录内的会话记录',
      'dialog.includeDescendants': '同时删除子代理会话',
      'dialog.descendants.autoOff': '已自动关闭「同时删除子代理会话」：取消勾选的子代理会话必须保留。重新勾选该行后可再开启。',
      'dialog.confirm.label': '请输入文件夹名称“{name}”以确认永久删除',
      'dialog.confirm.placeholder': '文件夹名称',
      'dialog.confirm.mismatch': '输入的文件夹名称不匹配',
      'dialog.footer.delete': '删除',
      'dialog.footer.clear': '清空会话',
      'dialog.items.workspace': '工作区目录',
      'dialog.items.session': '会话',
      'dialog.items.subagent': '子代理会话',
      'dialog.items.truncated': '统计达到扫描上限，大小只是下限',
      'dialog.item.meta': '{size} · {files} · {dirs}',
      'dialog.item.metaFiles': '{size} · {files}',
      'dialog.totals': '合计 {size} · {files} · {dirs}',
      'dialog.totalsRefreshing': '正在重新计算复核结果…',
      'dialog.expires': '本次检查结果在 {time} 前有效',
      'dialog.blocker.hint': '请先处理上面的问题，然后重试。',
      'dialog.blocker.sessionHeld.title': '本次启动内无法删除',
      'dialog.blocker.sessionHeld.liveItem': '该会话已在本次启动中打开；DSH 会持有它的写入句柄，直到进程退出。',
      'dialog.blocker.sessionHeld.runningItem': '该会话正在运行；DSH 会持有它的写入句柄，直到进程退出。',
      'dialog.blocker.sessionHeld.workspaceItem': '该目录中有在本次启动中打开的会话；DSH 会持有它们的写入句柄，直到进程退出。',
      'dialog.blocker.sessionHeld.body': '所以本次启动内无法删除它。可以选择“{schedule}”，或“{cancel}”本次不处理。',
      'dialog.defer.action': '安排删除（本次启动结束后自动执行）',
      'dialog.defer.actionShort': '安排下次启动删除',
      'dialog.defer.unavailable': '还有其他类型的阻塞不会因重启而消失，因此不能安排到下次启动处理。',
      'dialog.deferring': '正在安排…',
      'dialog.deferred.title': '已安排删除',
      'dialog.deferred.summary_one': '已安排：重启 DSH 后自动删除 {count} 项',
      'dialog.deferred.summary_other': '已安排：重启 DSH 后自动删除 {count} 项',
      'dialog.deferred.mode': '删除方式：{mode}',
      'dialog.deferred.queue_one': '队列中现有 {count} 个待删除安排',
      'dialog.deferred.queue_other': '队列中现有 {count} 个待删除安排',
      'dialog.deferred.replaced': '已覆盖之前针对同一组目标的安排。',
      'dialog.deferred.note': '可以在“存储清理”页面查看或取消这些安排。',
      'dialog.done.title': '删除完成',
      'dialog.done.summary_one': '已删除 {count} 项，共 {size}',
      'dialog.done.summary_other': '已删除 {count} 项，共 {size}',
      'dialog.done.allFailedSummary_one': '{count} 项失败，没有删除任何内容。',
      'dialog.done.allFailedSummary_other': '{count} 项失败，没有删除任何内容。',
      'dialog.done.trashed': '已移入回收站：{path}',
      'dialog.done.trashedMany': '已移入回收站（{count} 项）：',
      'dialog.done.trashedMore_one': '另有 {count} 项，可在“存储清理 → 回收站”中查看。',
      'dialog.done.trashedMore_other': '另有 {count} 项，可在“存储清理 → 回收站”中查看。',
      'dialog.done.note': '可在“存储清理 → 回收站”中恢复。',
      'dialog.done.partial_one': '{count} 项删除失败，未自动关闭；请检查后重试。',
      'dialog.done.partial_other': '{count} 项删除失败，未自动关闭；请检查后重试。',
      'dialog.clear.title': '清空完成',
      'dialog.clear.emptyTitle': '没有可清理的会话',
      'dialog.clear.emptyNone': '这个工作区还没有会话记录。',
      'dialog.clear.emptyInUse_one': '{count} 条会话正在本次启动中打开或运行，无法立即删除；重启 DSH 后再试。',
      'dialog.clear.emptyInUse_other': '{count} 条会话正在本次启动中打开或运行，无法立即删除；重启 DSH 后再试。',
      'dialog.clear.deferredMore_one': '工作区还有 {count} 条会话未包含在本次安排中；重启后可再次清空。',
      'dialog.clear.deferredMore_other': '工作区还有 {count} 条会话未包含在本次安排中；重启后可再次清空。',
      'dialog.clear.failedTitle': '无法读取该工作区的会话',
      'dialog.clear.review_one': '“{title}”共有 {count} 条会话记录；本次复核前 {batch} 条，确认后自动分批处理其余部分。',
      'dialog.clear.review_other': '“{title}”共有 {count} 条会话记录；本次复核前 {batch} 条，确认后自动分批处理其余部分。',
      'dialog.clear.reviewEmpty_one': '“{title}”共有 {count} 条会话记录；在上方勾选要清空的会话，再确认。',
      'dialog.clear.reviewEmpty_other': '“{title}”共有 {count} 条会话记录；在上方勾选要清空的会话，再确认。',
      'dialog.clear.reviewLogs_one': '本次复核包含 {count} 条日志（含子代理会话）。',
      'dialog.clear.reviewLogs_other': '本次复核包含 {count} 条日志（含子代理会话）。',
      'dialog.clear.scope': '只删除会话记录，工作区目录与它的注册信息保持不变。',
      'dialog.clear.skipped_one': '另有 {count} 条正在本次启动中使用，无法立即删除，将被跳过；重启 DSH 后可再次清空。',
      'dialog.clear.skipped_other': '另有 {count} 条正在本次启动中使用，无法立即删除，将被跳过；重启 DSH 后可再次清空。',
      'dialog.clear.excluded_one': '已取消 {count} 条，不会被清空。',
      'dialog.clear.excluded_other': '已取消 {count} 条，不会被清空。',
      'dialog.clear.progress_one': '第 {batch} 批 · 已清理 {done} 条',
      'dialog.clear.progress_other': '第 {batch} 批 · 已清理 {done} 条',
      'dialog.clear.done_summary_one': '已清理 {count} 条会话记录，共 {size}',
      'dialog.clear.done_summary_other': '已清理 {count} 条会话记录，共 {size}',
      'dialog.clear.stop.blocked_one': '还有 {count} 条在当前状态无法删除，可稍后重试。',
      'dialog.clear.stop.blocked_other': '还有 {count} 条在当前状态无法删除，可稍后重试。',
      'dialog.clear.stop.failed_one': '还有 {count} 条未清理：删除请求失败。',
      'dialog.clear.stop.failed_other': '还有 {count} 条未清理：删除请求失败。',
      'dialog.clear.stop.limit': '已达单次清理的安全上限，请稍后再执行一次。',
      'dialog.clear.trashNote': '已清理的会话记录可在“存储清理 → 回收站”中恢复。',
      'dialog.clear.permNote': '永久删除的会话记录无法恢复。',
      'dialog.failed.planTitle': '无法准备删除计划',
      'dialog.failed.deleteTitle': '删除失败',
      'dialog.failed.deferTitle': '安排删除失败',
      'dialog.failed.code': '错误代码：{code}',
      'menu.deleteSession': '删除会话…',
      'menu.deleteWorkspace': '删除工作区目录…',
      'menu.clearWorkspaceSessions': '清空工作区会话…',
      'menu.clearWorkspaceSessions.failed': '无法识别该工作区的菜单目标，请刷新后重试。',
      'warn.WORKSPACE_MISSING': '工作区目录已不存在，只会删除注册信息。',
      'warn.WORKSPACE_HAS_GIT': '目录包含 .git，未提交的改动会一起丢失。',
      'warn.SCAN_TRUNCATED': '已达到扫描上限，显示的大小只是下限。',
      'warn.LARGE_TARGET': '目标超过 1 GB，删除可能需要一些时间。',
      'warn.SESSIONS_FROM_DIR': '有会话的日志位于别处但工作目录在此目录内；删除目录后这些会话将不再分组。',
      'warn.SESSION_HAS_DESCENDANTS': '该会话包含子代理会话，会被一并删除。',
      'warn.SESSION_NOT_DELETABLE': '有会话的存储结构无法识别，已跳过而不是让整份计划失败。',
      'warn.WORKSPACE_CONTAINS_WORKSPACE': '该目录内还有另一个已注册的工作区，删除会一并移除它（未在本次复核中单独列出）。',
      'warn.WORKSPACE_GIT_DIRTY': '该仓库有 {count} 处未提交或未跟踪的改动，删除该目录会丢失它们。',
      'warn.WORKSPACE_GIT_UNPUSHED': '该仓库有 {count} 个提交未推送到任何远程仓库。',
      'error.BAD_REQUEST': '请求无效，请刷新后重试。',
      'error.UNKNOWN_WORKSPACE': '该工作区已不存在，请刷新后重试。',
      'error.UNKNOWN_SESSION': '该会话已不存在，请刷新后重试。',
      'error.PLAN_UNKNOWN': '检查结果已失效，请重新检查。',
      'error.PLAN_EXPIRED': '检查结果已过期，请重新检查。',
      'error.STATE_CHANGED': '目标在检查后发生了变化，请重新检查。',
      'error.CONFIRMATION_REQUIRED': '需要输入文件夹名称才能永久删除。',
      'error.CONFIRMATION_MISMATCH': '输入的文件夹名称不匹配。',
      'error.PERMANENT_DISABLED': '当前未启用永久删除，请改用回收站。',
      'error.PERMANENT_MULTIPLE_DIRECTORIES': '永久删除每次只能处理一个工作区目录；批量删除请改用回收站。',
      'error.TRASH_UNAVAILABLE': '回收站不可用，目标无法移入。',
      'error.TRASH_CROSS_DEVICE': '目标与回收站不在同一磁盘，无法移入回收站；可以改用永久删除。',
      'error.TRASH_ENTRY_UNKNOWN': '回收站条目已不存在，请刷新。',
      'error.RESTORE_ORIGINAL_EXISTS': '原路径已存在，无法恢复。',
      'error.RESTORE_ORIGINAL_MISSING': '原路径的上级目录不存在，无法恢复。',
      'error.RESTORE_FAILED': '恢复失败，请重试。',
      'error.RESTORE_ENTRY_UNREADABLE': '回收站条目无法读取，无法恢复。',
      'error.RESTORE_PAYLOAD_INVALID': '回收站条目内容无效，无法恢复。',
      'error.RESTORE_PAYLOAD_MISSING': '回收站条目缺少内容，无法恢复。',
      'error.RESTORE_UNREADABLE': '回收站条目内容无法读取，无法恢复。',
      'error.PATH_NOT_ABSOLUTE': '该路径不是绝对路径，已拒绝删除。',
      'error.PATH_NOT_DIRECTORY': '该路径不是目录，已拒绝删除。',
      'error.PATH_NOT_SESSION_DIR': '该路径不是可识别的会话目录，已拒绝删除。',
      'error.SESSION_LIVE': '该会话正在使用中，删除会损坏日志。请先关闭该会话或重启应用，然后重试。',
      'error.SESSION_RUNNING': '该会话正在运行。请先停止运行或等待完成，然后重试。',
      'error.SESSION_NOT_DELETABLE': '该会话不可删除。',
      'error.WORKSPACE_MISSING': '工作区目录已不存在，只会删除注册信息。',
      'error.WORKSPACE_SYMLINK': '该工作区是符号链接，已拒绝删除。',
      'error.WORKSPACE_HAS_LIVE_SESSIONS': '该目录中有正在使用的会话，无法删除。请先关闭这些会话或重启应用，然后重试。',
      'error.WORKSPACE_CONTAINS_WORKSPACE': '该目录内还有另一个已注册的工作区，永久删除会一并销毁它，因此被拒绝。',
      'error.PATH_PROTECTED': '该路径受保护，已拒绝删除。',
      'error.PATH_SHALLOW': '该路径层级过浅，已拒绝删除。',
      'error.PATH_CHANGED': '该目录已被移动或替换，请刷新后重试。',
      'error.CONTAINS_DSH_HOME': '该目录包含 DSH 主目录，已拒绝删除。',
      'error.IO_ERROR': '文件系统操作失败，请稍后重试。',
      'error.UNCHECKED_TARGET_LEAK': '有已取消勾选的目标仍会被删除，已停止本次操作；请刷新后重试。',
      'error.INTERNAL': '服务器内部错误，请重试。',
      'error.DEFERRED_FULL': '待删除安排已满，请先取消一些后再试。',
      'error.DEFERRED_BUSY': '另一个进程正在更新或执行待删除队列，请稍后重试。',
      'error.DEFERRED_TARGETS_CHANGED': '待删除的复核结果已变化（会出现当时未复核的项目），请重新复核后再安排。',
      'error.DEFERRED_ENTRY_UNKNOWN': '该待删除安排已不存在，请刷新后重试。',
    }

    const en = {
      'section.label': 'Storage cleanup',
      'page.title': 'Storage cleanup',
      'page.intro': 'Review the impact before deleting workspace folders or session logs; by default they move to a recoverable trash.',
      'page.refresh': 'Refresh',
      'page.measure': 'Measure sizes',
      'page.footer.note': 'The trash is never emptied on a timer and can be restored at any time; permanent deletion cannot be undone.',
      'page.truncated': 'The session list reached its cap, so only part of it is shown.',
      'page.truncated.cap': 'The session list reached its cap of {count} entries, so only part of it is shown.',
      'page.loading': 'Loading…',
      'page.error': 'Could not load',
      'page.empty.workspaces': 'No registered workspaces yet.',
      'page.empty.sessions': 'No sessions yet.',
      'page.empty.sessionsFiltered': 'No sessions match the current filter.',
      'page.empty.trash': 'The trash is empty.',
      'page.select': 'Select',
      'page.selectedCount_one': '{count} selected',
      'page.selectedCount_other': '{count} selected',
      'page.showMore_one': 'Show more ({count} remaining)',
      'page.showMore_other': 'Show more ({count} remaining)',
      'tab.workspaces': 'Workspaces',
      'tab.sessions': 'Sessions',
      'tab.trash': 'Trash',
      'tab.settings': 'Cleanup settings',
      'settings.group.deletion': 'Deletion permission',
      'settings.group.trash': 'Trash',
      'settings.group.audit': 'Audit log',
      'settings.group.advanced': 'Advanced',
      'settings.field.allowPermanentDeletion': 'Allow permanent deletion',
      'settings.field.allowPermanentDeletionHint': 'When off, targets can only be moved to the trash',
      'settings.field.trashRetentionDays': 'Trash retention (days)',
      'settings.field.trashRetentionDaysHint': 'Warn when the oldest entry is older than this; 0 = off',
      'settings.field.trashMaxBytes': 'Trash size limit (MB)',
      'settings.field.trashMaxBytesHint': 'Warn when the trash exceeds this size; 0 = off',
      'settings.field.auditEnabled': 'Record the deletion audit log',
      'settings.field.auditEnabledHint': 'Records deletions, skips, restores, purges and queue operations',
      'settings.field.auditMaxBytes': 'Audit log size limit (MB)',
      'settings.field.auditMaxBytesHint': 'Rotates to audit.jsonl.1 past this size; 0 = never',
      'settings.field.maxScanEntries': 'Scan entry limit',
      'settings.field.maxScanEntriesHint': 'Maximum entries one directory scan may walk',
      'settings.field.scanTimeoutMs': 'Scan timeout (ms)',
      'settings.field.scanTimeoutMsHint': 'Wall-clock budget for one directory scan',
      'settings.field.planTtlMs': 'Check validity (ms)',
      'settings.field.planTtlMsHint': 'How long a deletion plan stays valid after creation',
      'settings.field.maxPlans': 'Retained checks',
      'settings.field.maxPlansHint': 'Oldest checks are evicted past this many',
      'settings.field.trashRoot': 'Trash location',
      'settings.field.trashRootHint': 'Moving it leaves existing trash entries at the old location; nothing is migrated',
      'settings.field.notEditable': 'Read-only',
      'settings.field.gitSafetyCheck': 'Check for uncommitted or unpushed Git work',
      'settings.field.gitSafetyCheckHint': 'Read-only git probe before deleting a workspace folder; warns only, never blocks',
      'settings.reset': 'Reset to defaults',
      'settings.resetHint': 'Applies after you press Save',
      'settings.save': 'Save',
      'settings.unchanged': 'No changes to save',
      'settings.notWritable': 'The settings file is not writable right now; changes apply to this run only',
      'settings.saving': 'Saving…',
      'settings.saved': 'Saved',
      'settings.savedVolatile': 'Saved for this run only (the settings file could not be written)',
      'settings.persistError': 'Could not write the settings file: {message}',
      'settings.error.number': '{label} must be a number',
      'settings.error.integer': '{label} must be an integer',
      'settings.error.range': '{label} must be between {min} and {max}',
      'settings.error.saveFailed': 'Could not save. Check the values and try again.',
      'trash.retention.title': 'Trash is over its suggested limit',
      'trash.retention.capacity': 'Using {size}, over the {max} limit',
      'trash.retention.capacityGeneric': 'Using {size}, over the configured size limit',
      'trash.retention.age_one': 'The oldest entry is {days} day old, over the {maxDays}-day retention period',
      'trash.retention.age_other': 'The oldest entry is {days} days old, over the {maxDays}-day retention period',
      'trash.retention.ageGeneric_one': 'The oldest entry is {days} day old, over the retention warning threshold',
      'trash.retention.ageGeneric_other': 'The oldest entry is {days} days old, over the retention warning threshold',
      'trash.retention.note': 'The plugin never deletes anything automatically; clean the oldest entries manually or delete entries permanently yourself.',
      'trash.retention.manual': 'No entries can be suggested for cleanup; choose "Delete permanently" on individual entries.',
      'trash.retention.purgeSuggested_one': 'Clean the oldest entry ({count} item)',
      'trash.retention.purgeSuggested_other': 'Clean the oldest entries ({count} items)',
      'trash.retention.armed_one': 'Armed to clean the oldest {count} item; activate again to confirm',
      'trash.retention.armed_other': 'Armed to clean the oldest {count} items; activate again to confirm',
      'deferred.retained.title': 'Unfinished from last start',
      'deferred.retained.empty': 'Nothing is left unfinished.',
      'deferred.retainedNotice_one': '{count} unfinished entry from the last start',
      'deferred.retainedNotice_other': '{count} unfinished entries from the last start',
      'deferred.retainedAt': 'Processed {time}',
      'deferred.retained.requeue': 'Schedule again',
      'deferred.retained.requeueConfirm': 'Confirm scheduling again',
      'deferred.retained.forget': 'Forget',
      'deferred.retained.forgetConfirm': 'Confirm forgetting',
      'deferred.retained.requeueArmed': 'Armed to schedule this entry again; activate again to confirm',
      'deferred.retained.forgetArmed': 'Armed to forget this entry; activate again to confirm',
      'deferred.retained.requeued_one': 'Scheduled {count} entry again',
      'deferred.retained.requeued_other': 'Scheduled {count} entries again',
      'deferred.retained.forgotten_one': 'Forgot {count} entry',
      'deferred.retained.forgotten_other': 'Forgot {count} entries',
      'audit.title': 'Recent deletions',
      'audit.empty': 'No deletions recorded yet.',
      'audit.lastStartup': 'Last start ({time}): applied {applied} · skipped {skipped} · failed {failed}',
      'audit.source.startup': 'At startup',
      'audit.source.immediate': 'Manual',
      'audit.action.delete': 'Delete',
      'audit.action.skip': 'Skip',
      'audit.action.defer': 'Schedule deletion',
      'audit.action.requeue': 'Schedule again',
      'audit.action.cancel': 'Cancel queued',
      'audit.action.restore': 'Restore',
      'audit.action.purge': 'Purge',
      'audit.action.startupRun': 'Startup run',
      'audit.action.unknown': 'Action',
      'audit.status.trashed': 'Moved to trash',
      'audit.status.deleted': 'Deleted',
      'audit.status.failed': 'Failed',
      'audit.status.skipped': 'Skipped',
      'audit.status.queued': 'Queued',
      'audit.status.requeued': 'Requeued',
      'audit.status.cancelled': 'Cancelled',
      'audit.status.done': 'Done',
      'audit.status.restored': 'Restored',
      'audit.status.purged': 'Purged',
      'audit.status.unknown': 'Unknown status',
      'audit.notice.title': 'Last startup result',
      'audit.notice.body': 'Applied {applied} · skipped {skipped} · failed {failed}',
      'audit.notice.link': 'Open cleanup settings',
      'audit.notice.dismiss': 'Got it',
      'measure.button': 'Measure',
      'measure.measuring': 'Measuring…',
      'measure.unmeasured': 'Not measured',
      'measure.truncated': 'The scan budget was reached; the real size is larger',
      'count.file_one': '{count} file',
      'count.file_other': '{count} files',
      'count.dir_one': '{count} dir',
      'count.dir_other': '{count} dirs',
      'workspace.sessions_one': '{count} session',
      'workspace.sessions_other': '{count} sessions',
      'badge.missing': 'Missing',
      'badge.unsafe': 'Unsafe',
      'badge.running': 'Running',
      'badge.live': 'Open',
      'badge.archived': 'Archived',
      'badge.subagent': 'Subagent',
      'badge.notDeletable': 'Not deletable',
      'session.untitled': 'Untitled session',
      'action.delete': 'Delete…',
      'action.deleteSelected_one': 'Delete selected ({count})',
      'action.deleteSelected_other': 'Delete selected ({count})',
      'action.clearSelection': 'Clear selection',
      'action.restore': 'Restore',
      'action.purge': 'Delete permanently',
      'action.purgeConfirm': 'Confirm permanent delete',
      'action.emptyTrash': 'Empty trash',
      'action.emptyTrashConfirm': 'Confirm empty trash',
      'action.cancel': 'Cancel',
      'action.retry': 'Retry',
      'action.close': 'Close',
      'action.done': 'Done',
      'a11y.rowAction': '{action}: {title}',
      'trash.summary_one': '{count} item · {size}',
      'trash.summary_other': '{count} items · {size}',
      'trash.movedAt': 'Moved',
      'trash.parentSession': 'Parent {id}',
      'trash.restoreUnavailable': 'Cannot be restored',
      'trash.purgeArmed': 'Confirmation required: activate again to permanently delete "{title}". This cannot be undone.',
      'trash.purgeAllArmed': 'Confirmation required: activate again to permanently empty the whole trash. This cannot be undone.',
      'trash.announce.restored': 'Restored from the trash: {title}',
      'trash.announce.purged_one': 'Permanently deleted {count} item from the trash.',
      'trash.announce.purged_other': 'Permanently deleted {count} items from the trash.',
      'deferred.section': 'Scheduled deletions',
      'deferred.notice_one': '{count} scheduled deletion · runs automatically at the next DSH start',
      'deferred.notice_other': '{count} scheduled deletions · run automatically at the next DSH start',
      'deferred.show': 'Show',
      'deferred.hide': 'Hide',
      'deferred.cancelAll': 'Cancel all',
      'deferred.cancelAllConfirm': 'Confirm cancel all',
      'deferred.cancelConfirm': 'Confirm cancel',
      'deferred.cancelArmed': 'Confirmation required: activate again to cancel this scheduled deletion.',
      'deferred.cancelAllArmed': 'Confirmation required: activate again to cancel every scheduled deletion.',
      'deferred.cancelled_one': 'Cancelled {count} scheduled deletion.',
      'deferred.cancelled_other': 'Cancelled {count} scheduled deletions.',
      'deferred.entryTitle_one': '{count} target',
      'deferred.entryTitle_other': '{count} targets',
      'deferred.workspaceTarget': 'Workspace {id}',
      'deferred.moreTargets_one': '{count} more target',
      'deferred.moreTargets_other': '{count} more targets',
      'deferred.queuedAt': 'Scheduled {time}',
      'deferred.mode': 'Mode: {mode}',
      'deferred.listTargets_one': '{count} target in total',
      'deferred.listTargets_other': '{count} targets in total',
      'deferred.lastRun_one': 'Last start processed {count} scheduled deletion across {items}',
      'deferred.lastRun_other': 'Last start processed {count} scheduled deletions across {items}',
      'deferred.lastRunItems_one': '{count} target',
      'deferred.lastRunItems_other': '{count} targets',
      'deferred.lastRunSkipped_one': '{count} skipped',
      'deferred.lastRunSkipped_other': '{count} skipped',
      'deferred.lastRunFailed_one': '{count} failed',
      'deferred.lastRunFailed_other': '{count} failed',
      'deferred.showDetails': 'Show non-successful entries',
      'deferred.hideDetails': 'Hide non-successful entries',
      'deferred.status.skipped': 'Skipped',
      'deferred.status.failed': 'Failed',
      'deferred.status.trashed': 'Moved to trash (partial failure)',
      'deferred.status.deleted': 'Deleted (partial failure)',
      'deferred.loading': 'Loading scheduled deletions…',
      'deferred.empty': 'Nothing is scheduled for deletion.',
      'sessions.sort.label': 'Sort',
      'sessions.workspaceFilter': 'Workspace',
      'sessions.workspaceFilter.all': 'All workspaces',
      'sessions.workspaceFilter.ungrouped': 'Ungrouped',
      'sessions.sort.newest': 'Newest first',
      'sessions.sort.oldest': 'Oldest first',
      'sessions.sort.largest': 'Largest measured',
      'sessions.sort.largestHint': 'Sorts by measured size, largest first; sessions without a measurement come last.',
      'sessions.filter.label': 'Archive status',
      'sessions.filter.all': 'All sessions',
      'sessions.filter.archived': 'Archived only',
      'sessions.filter.active': 'Hide archived',
      'sessions.wizard.action': 'Select by rules',
      'sessions.wizard.close': 'Close rule selection',
      'sessions.wizard.title': 'Select sessions by rules',
      'sessions.wizard.legend': 'Filter rules',
      'sessions.wizard.olderThanDays': 'Older than (days)',
      'sessions.wizard.olderThanDaysHint': '0 = any',
      'sessions.wizard.archived': 'Archived',
      'sessions.wizard.archived.all': 'All',
      'sessions.wizard.archived.only': 'Only archived',
      'sessions.wizard.archived.exclude': 'Exclude archived',
      'sessions.wizard.minBytes': 'At least (MB)',
      'sessions.wizard.minBytesHint': '0 = any',
      'sessions.wizard.workspace': 'Workspace',
      'sessions.wizard.workspace.any': 'Any workspace',
      'sessions.wizard.workspaceUnknown': 'Unknown workspace',
      'sessions.wizard.origin': 'Origin',
      'sessions.wizard.origin.all': 'All',
      'sessions.wizard.origin.root': 'Root sessions',
      'sessions.wizard.origin.subagent': 'Subagents',
      'sessions.wizard.requireDeletable': 'Only show sessions that can be deleted now',
      'sessions.wizard.sort': 'Sort',
      'sessions.wizard.sort.oldest': 'Oldest first',
      'sessions.wizard.sort.largest': 'Largest first',
      'sessions.wizard.capNote': 'Previews up to {limit} matches; a review plan holds at most {max} targets',
      'sessions.wizard.idle': 'Adjust the rules to preview matching sessions',
      'sessions.wizard.loading': 'Finding sessions…',
      'sessions.wizard.error': 'Could not load candidates',
      'sessions.wizard.empty': 'No sessions match these rules',
      'sessions.wizard.summary_one': '{count} match · {size} known',
      'sessions.wizard.summary_other': '{count} matches · {size} known',
      'sessions.wizard.announce_one': 'Found {count} matching session · {size} known',
      'sessions.wizard.announce_other': 'Found {count} matching sessions · {size} known',
      'sessions.wizard.truncated': 'Truncated to the first {limit} matches',
      'sessions.wizard.lowerBound': 'Some session sizes are unknown, so the total is a lower bound',
      'sessions.wizard.selectAll': 'Select all deletable (up to {max})',
      'sessions.wizard.selectedCount_one': '{count} selected',
      'sessions.wizard.selectedCount_other': '{count} selected',
      'sessions.wizard.capWarning_one': '{count} match; only the first {max} will be reviewed',
      'sessions.wizard.capWarning_other': '{count} matches; only the first {max} will be reviewed',
      'sessions.wizard.selectCap': 'At most {max} can be selected',
      'sessions.wizard.review_one': 'Review and delete ({count})',
      'sessions.wizard.review_other': 'Review and delete ({count})',
      'sessions.wizard.age_one': '{days} day ago',
      'sessions.wizard.age_other': '{days} days ago',
      'common.none': '—',
      'common.working': 'Working…',
      'error.network': 'The network request failed. Check the connection and try again.',
      'error.badResponse': 'The server returned a response that could not be read.',
      'error.unknown': 'The operation failed. Try again.',
      'error.CANCELLED': 'The request was cancelled; the remaining targets were not processed.',
      'dialog.title.session': 'Delete session',
      'dialog.title.workspace': 'Delete workspace folder',
      'dialog.title.mixed': 'Delete selected items',
      'dialog.title.workspaceSessions': 'Clear workspace sessions',
      'dialog.targets.count_one': '{count} item',
      'dialog.targets.count_other': '{count} items',
      'dialog.select.count_one': '{count} of {total} selected',
      'dialog.select.count_other': '{count} of {total} selected',
      'dialog.select.all': 'Select all',
      'dialog.select.invert': 'Invert',
      'dialog.select.required': 'Select at least one target',
      'dialog.select.excluded': 'Not selected — nothing is deleted',
      'dialog.select.pending': 'Re-planning…',
      'dialog.groups.show': 'Show',
      'dialog.groups.hide': 'Hide',
      'dialog.groups.descendants_one': '{count} subagent session',
      'dialog.groups.descendants_other': '{count} subagent sessions',
      'dialog.groups.swept_one': '{count} Session inside the folder',
      'dialog.groups.swept_other': '{count} Sessions inside the folder',
      'dialog.planning': 'Checking…',
      'dialog.replanning': 'Checking again…',
      'dialog.deleting': 'Deleting…',
      'dialog.deleting.elapsed_one': '{seconds} second elapsed',
      'dialog.deleting.elapsed_other': '{seconds} seconds elapsed',
      'dialog.deleting.items_one': 'Deleting {count} item',
      'dialog.deleting.items_other': 'Deleting {count} items',
      'dialog.deleting.button_one': 'Deleting… {seconds} s',
      'dialog.deleting.button_other': 'Deleting… {seconds} s',
      'dialog.section.targets': 'The following will be deleted',
      'dialog.section.warnings': 'Warnings',
      'dialog.section.blockers': 'Blocked',
      'dialog.mode.label': 'Deletion mode',
      'dialog.mode.trash': 'Move to trash (recoverable)',
      'dialog.mode.perm': 'Delete permanently (irrecoverable)',
      'dialog.mode.permDisabled': 'Permanent deletion is disabled in this configuration',
      'dialog.mode.permMulti': 'One workspace folder per plan for permanent deletion; use the trash mode for batches.',
      'dialog.mode.permAutoTrash': 'Permanent deletion accepts one workspace folder at a time; switched to trash.',
      'dialog.mode.trashHint': 'The target moves to the trash and can be restored later from Storage cleanup → Trash.',
      'dialog.mode.permHint': 'Permanent deletion skips the trash and cannot be undone; make sure the target is backed up.',
      'dialog.includeSessions': 'Also delete session logs inside this folder',
      'dialog.includeDescendants': 'Also delete its subagent sessions',
      'dialog.descendants.autoOff': '“Also delete its subagent sessions” was turned off automatically: an un-checked subagent session must be kept. Re-check that row to enable it again.',
      'dialog.confirm.label': 'Type the folder name "{name}" to confirm permanent deletion',
      'dialog.confirm.placeholder': 'Folder name',
      'dialog.confirm.mismatch': 'The folder name does not match',
      'dialog.footer.delete': 'Delete',
      'dialog.footer.clear': 'Clear sessions',
      'dialog.items.workspace': 'Workspace folder',
      'dialog.items.session': 'Session',
      'dialog.items.subagent': 'Subagent session',
      'dialog.items.truncated': 'The scan budget was reached; the size is a lower bound',
      'dialog.item.meta': '{size} · {files} · {dirs}',
      'dialog.item.metaFiles': '{size} · {files}',
      'dialog.totals': 'Total {size} · {files} · {dirs}',
      'dialog.totalsRefreshing': 'Recalculating the review…',
      'dialog.expires': 'This check is valid until {time}',
      'dialog.blocker.hint': 'Resolve the issues above, then try again.',
      'dialog.blocker.sessionHeld.title': 'Cannot be deleted in this app run',
      'dialog.blocker.sessionHeld.liveItem': 'This session was opened in this app run; DSH holds its write handle until the process exits.',
      'dialog.blocker.sessionHeld.runningItem': 'This session is running; DSH holds its write handle until the process exits.',
      'dialog.blocker.sessionHeld.workspaceItem': 'Sessions in this folder were opened in this app run; DSH holds their write handles until the process exits.',
      'dialog.blocker.sessionHeld.body': 'So it cannot be deleted now. Choose “{schedule}”, or “{cancel}” to leave it for now.',
      'dialog.defer.action': 'Schedule deletion (runs automatically after this app exits)',
      'dialog.defer.actionShort': 'Schedule for the next start',
      'dialog.defer.unavailable': 'Some blockers would not clear on a restart, so this plan cannot be scheduled for the next start.',
      'dialog.deferring': 'Scheduling…',
      'dialog.deferred.title': 'Deletion scheduled',
      'dialog.deferred.summary_one': 'Scheduled: {count} item will be deleted after DSH restarts',
      'dialog.deferred.summary_other': 'Scheduled: {count} items will be deleted after DSH restarts',
      'dialog.deferred.mode': 'Mode: {mode}',
      'dialog.deferred.queue_one': 'The queue now holds {count} scheduled deletion',
      'dialog.deferred.queue_other': 'The queue now holds {count} scheduled deletions',
      'dialog.deferred.replaced': 'This replaced the earlier scheduled deletion for the same targets.',
      'dialog.deferred.note': 'Review or cancel it in Storage cleanup.',
      'dialog.done.title': 'Deletion complete',
      'dialog.done.summary_one': 'Deleted {count} item, {size} in total',
      'dialog.done.summary_other': 'Deleted {count} items, {size} in total',
      'dialog.done.allFailedSummary_one': '{count} item failed and nothing was deleted.',
      'dialog.done.allFailedSummary_other': '{count} items failed and nothing was deleted.',
      'dialog.done.trashed': 'Moved to trash: {path}',
      'dialog.done.trashedMany': 'Moved to trash ({count} items):',
      'dialog.done.trashedMore_one': '{count} more is listed in Storage cleanup → Trash.',
      'dialog.done.trashedMore_other': '{count} more are listed in Storage cleanup → Trash.',
      'dialog.done.note': 'Restore it from Storage cleanup → Trash.',
      'dialog.done.partial_one': '{count} item failed to delete; the window stays open so you can check it.',
      'dialog.done.partial_other': '{count} items failed to delete; the window stays open so you can check them.',
      'dialog.clear.title': 'Workspace sessions cleared',
      'dialog.clear.emptyTitle': 'No sessions to clear',
      'dialog.clear.emptyNone': 'This workspace has no session logs yet.',
      'dialog.clear.emptyInUse_one': '{count} session log is open or running in this app run and cannot be deleted now; restart DSH and try again.',
      'dialog.clear.emptyInUse_other': '{count} session logs are open or running in this app run and cannot be deleted now; restart DSH and try again.',
      'dialog.clear.deferredMore_one': '{count} other Session is not part of this schedule; run the clear again after restarting.',
      'dialog.clear.deferredMore_other': '{count} other Sessions are not part of this schedule; run the clear again after restarting.',
      'dialog.clear.failedTitle': 'Could not read this workspace’s sessions',
      'dialog.clear.review_one': "“{title}” holds {count} session log; this review covers the first {batch}, and confirming clears the rest batch by batch.",
      'dialog.clear.review_other': "“{title}” holds {count} session logs; this review covers the first {batch}, and confirming clears the rest batch by batch.",
      'dialog.clear.reviewEmpty_one': "“{title}” holds {count} session log; check the ones to clear above, then confirm.",
      'dialog.clear.reviewEmpty_other': "“{title}” holds {count} session logs; check the ones to clear above, then confirm.",
      'dialog.clear.reviewLogs_one': 'This review covers {count} session log (including subagent sessions).',
      'dialog.clear.reviewLogs_other': 'This review covers {count} session logs (including subagent sessions).',
      'dialog.clear.scope': 'Only the session logs are deleted; the workspace folder and its registration stay as they are.',
      'dialog.clear.skipped_one': '{count} more is in use in this app run and is skipped; run the clear again after restarting DSH.',
      'dialog.clear.skipped_other': '{count} more are in use in this app run and are skipped; run the clear again after restarting DSH.',
      'dialog.clear.excluded_one': '{count} was un-checked and will not be cleared.',
      'dialog.clear.excluded_other': '{count} were un-checked and will not be cleared.',
      'dialog.clear.progress_one': 'Batch {batch} · {done} cleared',
      'dialog.clear.progress_other': 'Batch {batch} · {done} cleared',
      'dialog.clear.done_summary_one': 'Cleared {count} session log, {size} in total',
      'dialog.clear.done_summary_other': 'Cleared {count} session logs, {size} in total',
      'dialog.clear.stop.blocked_one': '{count} more cannot be deleted in its current state; try again later.',
      'dialog.clear.stop.blocked_other': '{count} more cannot be deleted in their current state; try again later.',
      'dialog.clear.stop.failed_one': '{count} more was not cleared: the delete request failed.',
      'dialog.clear.stop.failed_other': '{count} more were not cleared: the delete request failed.',
      'dialog.clear.stop.limit': 'The per-run safety limit was reached; run the clear again to continue.',
      'dialog.clear.trashNote': 'Cleared session logs can be restored from Storage cleanup → Trash.',
      'dialog.clear.permNote': 'Permanently deleted session logs cannot be restored.',
      'dialog.failed.planTitle': 'Could not prepare the deletion plan',
      'dialog.failed.deleteTitle': 'Deletion failed',
      'dialog.failed.deferTitle': 'Could not schedule the deletion',
      'dialog.failed.code': 'Error code: {code}',
      'menu.deleteSession': 'Delete session…',
      'menu.deleteWorkspace': 'Delete workspace folder…',
      'menu.clearWorkspaceSessions': 'Clear workspace sessions…',
      'menu.clearWorkspaceSessions.failed': 'Could not resolve this workspace menu target; refresh and try again.',
      'warn.WORKSPACE_MISSING': 'The workspace folder no longer exists; only the registration will be removed.',
      'warn.WORKSPACE_HAS_GIT': 'The folder contains .git, so uncommitted work will be lost.',
      'warn.SCAN_TRUNCATED': 'The scan budget was reached; the shown size is a lower bound.',
      'warn.LARGE_TARGET': 'The target is over 1 GB, so deletion may take a while.',
      'warn.SESSIONS_FROM_DIR': 'Some session logs live elsewhere but use this folder as their working directory; they will lose their grouping.',
      'warn.SESSION_HAS_DESCENDANTS': 'This session has subagent sessions, which will be deleted too.',
      'warn.SESSION_NOT_DELETABLE': 'A session with an unrecognizable stored layout was skipped instead of failing the whole plan.',
      'warn.WORKSPACE_CONTAINS_WORKSPACE': 'Another registered workspace is nested inside this folder and will be removed with it, without its own review step.',
      'warn.WORKSPACE_GIT_DIRTY': 'This repository has {count} uncommitted or untracked change(s); deleting this folder loses them.',
      'warn.WORKSPACE_GIT_UNPUSHED': 'This repository has {count} commit(s) that are not on any remote.',
      'error.BAD_REQUEST': 'The request was invalid. Refresh and try again.',
      'error.UNKNOWN_WORKSPACE': 'This workspace no longer exists. Refresh and try again.',
      'error.UNKNOWN_SESSION': 'This session no longer exists. Refresh and try again.',
      'error.PLAN_UNKNOWN': 'The check is no longer valid. Check again.',
      'error.PLAN_EXPIRED': 'The check expired. Check again.',
      'error.STATE_CHANGED': 'The target changed after the check. Review it again.',
      'error.CONFIRMATION_REQUIRED': 'The folder name is required for permanent deletion.',
      'error.CONFIRMATION_MISMATCH': 'The folder name does not match.',
      'error.PERMANENT_DISABLED': 'Permanent deletion is disabled; use the trash instead.',
      'error.PERMANENT_MULTIPLE_DIRECTORIES': 'Permanent deletion handles one workspace folder per plan; use the trash for batches.',
      'error.TRASH_UNAVAILABLE': 'The trash is unavailable, so the target cannot be moved.',
      'error.TRASH_CROSS_DEVICE': 'The target and the trash are on different disks and cannot be moved between them; permanent deletion is an alternative.',
      'error.TRASH_ENTRY_UNKNOWN': 'This trash entry no longer exists. Refresh.',
      'error.RESTORE_ORIGINAL_EXISTS': 'The original path already exists, so it cannot be restored.',
      'error.RESTORE_ORIGINAL_MISSING': 'The original parent directory is missing, so it cannot be restored.',
      'error.RESTORE_FAILED': 'Restoring failed. Try again.',
      'error.RESTORE_ENTRY_UNREADABLE': 'The trash entry cannot be read, so it cannot be restored.',
      'error.RESTORE_PAYLOAD_INVALID': 'The trash entry payload is invalid, so it cannot be restored.',
      'error.RESTORE_PAYLOAD_MISSING': 'The trash entry has no payload, so it cannot be restored.',
      'error.RESTORE_UNREADABLE': 'The trash entry contents cannot be read, so it cannot be restored.',
      'error.PATH_NOT_ABSOLUTE': 'This path is not absolute; deletion is refused.',
      'error.PATH_NOT_DIRECTORY': 'This path is not a directory; deletion is refused.',
      'error.PATH_NOT_SESSION_DIR': 'This path is not a recognizable session directory; deletion is refused.',
      'error.SESSION_LIVE': 'This session is in use; deleting its log would corrupt it. Close the session or restart the app, then try again.',
      'error.SESSION_RUNNING': 'This session is running. Stop it or wait for it to finish, then try again.',
      'error.SESSION_NOT_DELETABLE': 'This session cannot be deleted.',
      'error.WORKSPACE_MISSING': 'The workspace folder no longer exists; only the registration will be removed.',
      'error.WORKSPACE_SYMLINK': 'This workspace is a symbolic link; deletion is refused.',
      'error.WORKSPACE_HAS_LIVE_SESSIONS': 'Sessions in this folder are in use, so it cannot be deleted. Close them or restart the app, then try again.',
      'error.WORKSPACE_CONTAINS_WORKSPACE': 'Another registered workspace is nested inside this folder, so permanent deletion of the whole folder is refused.',
      'error.PATH_PROTECTED': 'This path is protected; deletion is refused.',
      'error.PATH_SHALLOW': 'This path is too shallow; deletion is refused.',
      'error.PATH_CHANGED': 'The folder was moved or replaced. Refresh and try again.',
      'error.CONTAINS_DSH_HOME': 'This folder contains the DSH home directory; deletion is refused.',
      'error.IO_ERROR': 'A file system operation failed. Try again later.',
      'error.UNCHECKED_TARGET_LEAK': 'A target you un-checked would still be deleted, so the operation stopped; refresh and try again.',
      'error.INTERNAL': 'The server hit an internal error. Try again.',
      'error.DEFERRED_FULL': 'The scheduled-deletion queue is full. Cancel some entries and try again.',
      'error.DEFERRED_BUSY': 'Another process is updating or applying the deferred queue. Try again in a moment.',
      'error.DEFERRED_TARGETS_CHANGED': 'The reviewed deletion set changed since it was queued. Review it anew and schedule it again.',
      'error.DEFERRED_ENTRY_UNKNOWN': 'That scheduled deletion no longer exists. Refresh and try again.',
    }

    /**
     * Additional locale dictionaries, filled by the release script for the language-pack
     * ids activated in this build. The markers are load-bearing: the script rewrites only
     * the block between them. Baseline DSH UI locales are `zh` and `en`; other languages
     * arrive through language-pack plugins, so nothing is translated here upfront.
     */
    const EXTRA_LOCALE_DICTIONARIES = {
      // LOCALE_DICTIONARIES_START
      // LOCALE_DICTIONARIES_END
    }

    function hasKey(key) {
      return Object.prototype.hasOwnProperty.call(en, key)
    }

    // ---------------------------------------------------------------- format

    const numberFormat0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
    const numberFormat1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
    const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

    function formatNumber(value) {
      const numeric = typeof value === 'number' && isFinite(value) ? value : 0
      return numberFormat0.format(numeric)
    }

    /** KB/MB/GB thresholds with locale-aware grouping (SPEC §11). */
    function formatBytes(value) {
      const bytes = typeof value === 'number' && isFinite(value) && value > 0 ? value : 0
      if (bytes < 1024) return numberFormat0.format(bytes) + ' B'
      const units = ['KB', 'MB', 'GB', 'TB', 'PB']
      let scaled = bytes / 1024
      let index = 0
      while (scaled >= 1024 && index < units.length - 1) {
        scaled = scaled / 1024
        index += 1
      }
      const formatter = scaled < 10 ? numberFormat1 : numberFormat0
      return formatter.format(scaled) + ' ' + units[index]
    }

    function formatTime(milliseconds) {
      if (typeof milliseconds !== 'number' || !isFinite(milliseconds) || milliseconds <= 0) return ''
      try {
        return timeFormat.format(new Date(milliseconds))
      } catch (error) {
        return ''
      }
    }

    // ---------------------------------------------------------- locale plurals

    /**
     * Active UI locale id, refreshed by `registerLocale` from the shared locale runtime.
     * Module-level on purpose: the copy layer (`plural`) and the bound translator are
     * shared by every mount of this plugin in one page.
     */
    let activeLocaleId = null
    /** One `Intl.PluralRules` per locale id; a language-pack registration needs no new code. */
    const pluralRulesCache = new Map()
    /**
     * The dictionaries actually registered with the locale runtime this load
     * (baseline zh/en plus EXTRA_LOCALE_DICTIONARIES). Kept module-level so the
     * variant lookup can see a language pack's extra plural keys (`_few`/`_many`),
     * which never exist in the English baseline.
     */
    let registeredDictionarySet = null

    /** @returns {Intl.PluralRules | null} rules for one locale id (cached, never throws). */
    function pluralRulesFor(localeId) {
      const id = typeof localeId === 'string' && localeId !== '' ? localeId : 'en'
      if (pluralRulesCache.has(id)) return pluralRulesCache.get(id)
      let rules = null
      try {
        rules = typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function'
          ? new Intl.PluralRules(id)
          : null
      } catch (error) {
        try {
          rules = typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function'
            ? new Intl.PluralRules('en')
            : null
        } catch (ignored) {
          rules = null
        }
      }
      pluralRulesCache.set(id, rules)
      return rules
    }

    /** The dictionary for one locale id in this load, else the English baseline. */
    function dictionaryFor(localeId) {
      const set = registeredDictionarySet
      if (!set) return en
      if (typeof localeId === 'string' && localeId !== '' && set[localeId] && typeof set[localeId] === 'object') {
        return set[localeId]
      }
      return set.en && typeof set.en === 'object' ? set.en : en
    }

    /**
     * Variant existence for the plural fallback chain. The active language's own
     * dictionary wins (a language pack may add `_few`/`_many`), then the English
     * baseline, which is the locale runtime's final fallback for every language.
     */
    function hasPluralVariant(key) {
      const active = dictionaryFor(activeLocaleId)
      if (active && Object.prototype.hasOwnProperty.call(active, key)) return true
      const set = registeredDictionarySet
      if (set && set.en && Object.prototype.hasOwnProperty.call(set.en, key)) return true
      return hasKey(key)
    }

    /** Pick `active` out of a locale snapshot, when it carries one. */
    function readLocaleIdFromSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return null
      const active = snapshot.active
      return typeof active === 'string' && active !== '' ? active : null
    }

    /** Read the current locale id from the shared locale runtime (all access guarded). */
    function readActiveLocaleId(locale) {
      if (!locale) return null
      try {
        if (typeof locale.getLocale === 'function') {
          const id = readLocaleIdFromSnapshot(locale.getLocale())
          if (id !== null) return id
        }
        if (typeof locale.getSnapshot === 'function') {
          const id = readLocaleIdFromSnapshot(locale.getSnapshot())
          if (id !== null) return id
        }
      } catch (error) {
        /* an unreadable locale runtime keeps the previous id (default `en` rules) */
      }
      return null
    }

    function setActiveLocaleId(value) {
      if (typeof value !== 'string' || value === '') return
      activeLocaleId = value
    }

    /**
     * Plural category for a count in the ACTIVE locale. A language pack that activates
     * `ru` (one/few/many/other) or `ja` (other only) is picked up without client changes;
     * zh/en output is unchanged because their baseline rules map to the same variants.
     */
    function pluralCategoryFor(count) {
      const value = typeof count === 'number' && isFinite(count) ? count : 0
      const rules = pluralRulesFor(activeLocaleId)
      if (rules !== null) {
        try {
          const category = rules.select(value)
          if (typeof category === 'string' && category !== '') return category
        } catch (error) { /* fall through to the numeric rule */ }
      }
      return value === 1 ? 'one' : 'other'
    }

    /**
     * `plural(t, 'count.file', 3)` → `key_<category>` → `key_other` → `key_one` → bare key,
     * with `{count}` filled. Missing variants fall through, so an English-only dictionary
     * still renders for a language pack that has more plural categories.
     */
    function plural(t, key, count, params) {
      const value = typeof count === 'number' && isFinite(count) ? count : 0
      const merged = Object.assign({ count: formatNumber(value) }, params)
      const category = pluralCategoryFor(value)
      const chain = [category, 'other', 'one']
      for (let i = 0; i < chain.length; i += 1) {
        const variant = key + '_' + chain[i]
        if (hasPluralVariant(variant)) return t(variant, merged)
      }
      return t(key, merged)
    }

    function middleEllipsis(text, max) {
      const value = typeof text === 'string' ? text : ''
      if (value.length <= max) return value
      const tail = Math.ceil((max - 1) / 2)
      const headLength = max - 1 - tail
      return value.slice(0, headLength) + '…' + value.slice(value.length - tail)
    }

    function baseName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]+/).filter(function (part) { return part.length > 0 })
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    function shortId(id) {
      const value = typeof id === 'string' ? id : ''
      if (value.length <= 10) return value
      return value.slice(value.length - 8)
    }

    /** Turn an arbitrary target/session key into a DOM-id-safe fragment. */
    function domIdSafe(value) {
      return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '-')
    }

    function isAbortError(error) {
      if (!error) return false
      return error.name === 'AbortError' || error.code === 20 || error.code === 'ABORT_ERR'
    }

    // --------------------------------------------------------- tiny utilities

    /** Minimal immutable store for React.useSyncExternalStore. */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        setState: function (patch) {
          const next = typeof patch === 'function' ? patch(snapshot) : Object.assign({}, snapshot, patch)
          if (next === snapshot) return
          snapshot = next
          Array.from(listeners).forEach(function (listener) {
            try { listener() } catch (error) { /* a broken subscriber must not break the store */ }
          })
        },
      }
    }

    /**
     * Stable inert store used only when the framework injects no `api` props into
     * a component (defensive: the registrations below always inject it). Keeping a
     * stable snapshot also satisfies useSyncExternalStore's identity contract.
     */
    const FALLBACK_DIALOG_STORE = (function () {
      const snapshot = initialDialogState()
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function () { return function () { } },
      }
    })()

    const FALLBACK_PAGE_STORE = (function () {
      const snapshot = initialPageState()
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function () { return function () { } },
        loadInventory: function () { return Promise.resolve() },
        dispose: function () { },
      }
    })()

    /** Stable inert catalog used when `api` is not injected (registration always injects it). */
    const FALLBACK_CATALOG = {
      getSnapshot: function () { return null },
      subscribe: function () { return function () { } },
    }

    /** Stable identity for a dialog target (`kind:id`), used by the review checkboxes. */
    function targetKey(target) {
      const kind = target && typeof target.kind === 'string' ? target.kind : ''
      const id = target && typeof target.id === 'string' ? target.id : ''
      return kind + ':' + id
    }

    /** Captured target may be a plain value (see SPEC §7: read the value, not `.value`). */
    function normalizeTargets(rawTargets) {
      const seen = {}
      const targets = []
      const list = Array.isArray(rawTargets) ? rawTargets : []
      for (let i = 0; i < list.length; i += 1) {
        const candidate = list[i]
        if (!candidate || typeof candidate !== 'object') continue
        const kind = candidate.kind === 'workspace' ? 'workspace' : (candidate.kind === 'session' ? 'session' : null)
        if (kind === null) continue
        const id = typeof candidate.id === 'string' ? candidate.id : null
        if (id === null || id === '') continue
        const key = kind + ':' + id
        if (seen[key]) continue
        seen[key] = true
        const target = { kind: kind, id: id }
        if (typeof candidate.title === 'string' && candidate.title !== '') target.title = candidate.title
        if (typeof candidate.path === 'string' && candidate.path !== '') target.path = candidate.path
        if (typeof candidate.cwd === 'string' && candidate.cwd !== '') target.cwd = candidate.cwd
        targets.push(target)
      }
      return targets
    }

    /** `{ at, results }` last-run summary from inventory or `deferred.list`, or null. */
    function normalizeDeferredLastRun(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const results = Array.isArray(value.results)
        ? value.results.filter(function (result) { return result && typeof result === 'object' && !Array.isArray(result) })
        : []
      return {
        at: typeof value.at === 'number' && isFinite(value.at) && value.at > 0 ? value.at : null,
        results: results,
      }
    }

    /** Non-negative integer from a wire number, else 0. */
    function boundedCount(value, min, max) {
      if (typeof value !== 'number' || !isFinite(value)) return min
      const clamped = Math.floor(value)
      if (clamped < min) return min
      if (typeof max === 'number' && clamped > max) return max
      return clamped
    }

    /** `inventory.deferred` = `{ count, retained, lastRun }` (queue size for the persistent notice). */
    function normalizeDeferredSummary(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      return {
        count: boundedCount(value.count, 0),
        retained: boundedCount(value.retained, 0),
        lastRun: normalizeDeferredLastRun(value.lastRun),
      }
    }

    function normalizeDeferredTarget(target) {
      if (!target || typeof target !== 'object' || Array.isArray(target)) return null
      if (target.kind !== 'workspace' && target.kind !== 'session') return null
      if (typeof target.id !== 'string' || target.id === '') return null
      return { kind: target.kind, id: target.id }
    }

    function normalizeDeferredEntry(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const targets = []
      const rawTargets = Array.isArray(entry.targets) ? entry.targets : []
      for (let i = 0; i < rawTargets.length; i += 1) {
        const target = normalizeDeferredTarget(rawTargets[i])
        if (target !== null) targets.push(target)
      }
      return {
        id: typeof entry.id === 'string' ? entry.id : (typeof entry.id === 'number' ? String(entry.id) : ''),
        queuedAt: typeof entry.queuedAt === 'number' && isFinite(entry.queuedAt) ? entry.queuedAt : 0,
        mode: entry.mode === 'permanent' ? 'permanent' : 'trash',
        targets: targets,
        includeSessions: entry.includeSessions === true,
        includeDescendants: entry.includeDescendants === true,
      }
    }

    /** One retained (skipped/failed) start-up entry from `deferred.list` (SPEC §4.7). */
    function normalizeRetainedEntry(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const targets = []
      const rawTargets = Array.isArray(value.targets) ? value.targets : []
      for (let i = 0; i < rawTargets.length; i += 1) {
        const target = normalizeDeferredTarget(rawTargets[i])
        if (target !== null) targets.push(target)
      }
      const id = typeof value.id === 'string' ? value.id : (typeof value.id === 'number' ? String(value.id) : '')
      if (id === '') return null
      return {
        id: id,
        at: typeof value.at === 'number' && isFinite(value.at) && value.at > 0 ? value.at : 0,
        status: value.status === 'failed' ? 'failed' : 'skipped',
        code: typeof value.code === 'string' && value.code !== '' ? value.code : null,
        reason: typeof value.reason === 'string' ? value.reason : '',
        mode: value.mode === 'permanent' ? 'permanent' : 'trash',
        targets: targets,
      }
    }

    /** `POST api/cleanup.deferred.list` → `{ entries, retained, lastRun }` (normalized). */
    function normalizeDeferredList(payload) {
      const deferred = payload && payload.deferred && typeof payload.deferred === 'object' && !Array.isArray(payload.deferred)
        ? payload.deferred
        : {}
      const entries = []
      const rawEntries = Array.isArray(deferred.entries) ? deferred.entries : []
      for (let i = 0; i < rawEntries.length; i += 1) {
        const entry = normalizeDeferredEntry(rawEntries[i])
        if (entry !== null) entries.push(entry)
      }
      const retained = []
      const rawRetained = Array.isArray(deferred.retained) ? deferred.retained : []
      for (let i = 0; i < rawRetained.length; i += 1) {
        const record = normalizeRetainedEntry(rawRetained[i])
        if (record !== null) retained.push(record)
      }
      return { entries: entries, retained: retained, lastRun: normalizeDeferredLastRun(deferred.lastRun) }
    }

    // ------------------------------------------------------- cleanup wizard state

    /** Default rule set for a freshly opened wizard (SPEC §4.9 request shape). */
    function defaultWizardFilters() {
      return {
        olderThanDays: '0',
        archived: 'all',
        minBytesMb: '0',
        workspaceId: '',
        origin: 'all',
        requireDeletable: true,
      }
    }

    /** The idle preview shape. */
    function initialWizardPreview() {
      return {
        status: 'idle',
        candidates: [],
        total: 0,
        truncated: false,
        totals: { count: 0, bytes: 0 },
        filters: null,
        sort: null,
        error: null,
        fieldErrors: {},
      }
    }

    /** One candidate row from `POST api/cleanup.candidates` (SPEC §4.9). */
    function normalizeCandidate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      if (typeof value.id !== 'string' || value.id === '') return null
      const blockerCodes = []
      const rawCodes = Array.isArray(value.blockerCodes) ? value.blockerCodes : []
      for (let i = 0; i < rawCodes.length; i += 1) {
        if (typeof rawCodes[i] === 'string' && rawCodes[i] !== '') blockerCodes.push(rawCodes[i])
      }
      return {
        id: value.id,
        workspaceId: typeof value.workspaceId === 'string' && value.workspaceId !== '' ? value.workspaceId : null,
        cwd: typeof value.cwd === 'string' ? value.cwd : null,
        createdAt: typeof value.createdAt === 'number' && isFinite(value.createdAt) ? value.createdAt : 0,
        sizeBytes: typeof value.sizeBytes === 'number' && isFinite(value.sizeBytes) && value.sizeBytes >= 0 ? value.sizeBytes : null,
        origin: typeof value.origin === 'string' ? value.origin : null,
        live: value.live === true,
        running: value.running === true,
        archived: value.archived === true,
        pinned: value.pinned === true,
        deletable: value.deletable === true && blockerCodes.length === 0,
        blockerCodes: blockerCodes,
      }
    }

    /** Normalize the wizard preview payload. */
    function normalizeCandidates(payload) {
      const rows = []
      const raw = Array.isArray(payload && payload.candidates) ? payload.candidates : []
      for (let i = 0; i < raw.length; i += 1) {
        const candidate = normalizeCandidate(raw[i])
        if (candidate !== null) rows.push(candidate)
      }
      const totals = payload && payload.totals && typeof payload.totals === 'object' && !Array.isArray(payload.totals)
        ? payload.totals
        : {}
      return {
        candidates: rows,
        total: boundedCount(payload && payload.total, 0),
        truncated: payload ? payload.truncated === true : false,
        totals: {
          count: boundedCount(totals.count, 0),
          bytes: boundedCount(totals.bytes, 0),
        },
        filters: payload && payload.filters && typeof payload.filters === 'object' ? payload.filters : null,
        sort: payload && typeof payload.sort === 'string' ? payload.sort : null,
      }
    }

    /** Default wizard selection: the first `min(64, candidates.length)` deletable rows. */
    function wizardDefaultSelection(candidates) {
      const selected = []
      const rows = Array.isArray(candidates) ? candidates : []
      for (let i = 0; i < rows.length && selected.length < WIZARD_TARGET_MAX; i += 1) {
        if (rows[i] && rows[i].deletable === true) selected.push(rows[i].id)
      }
      return selected
    }

    /** Workspace display label for a wizard row, from the current inventory. */
    function workspaceLabelFor(inventory, workspaceId, t) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return t('sessions.wizard.workspaceUnknown')
      const rows = inventory && Array.isArray(inventory.workspaces) ? inventory.workspaces : []
      for (let i = 0; i < rows.length; i += 1) {
        if (!rows[i] || rows[i].id !== workspaceId) continue
        if (typeof rows[i].title === 'string' && rows[i].title !== '') return rows[i].title
        const base = baseName(rows[i].path)
        return base !== '' ? base : t('sessions.wizard.workspaceUnknown')
      }
      return t('sessions.wizard.workspaceUnknown')
    }

    /** Whole days since a session was created (0 when unknown). */
    function sessionAgeDays(createdAt) {
      if (typeof createdAt !== 'number' || !isFinite(createdAt) || createdAt <= 0) return 0
      const age = Date.now() - createdAt
      return age > 0 ? Math.floor(age / 86400000) : 0
    }

    /** Localize one session blocker/warning code (error.* wins, then warn.*). */
    function sessionCodeLabel(t, code) {
      if (typeof code !== 'string' || code === '') return t('error.unknown')
      if (hasKey('error.' + code)) return t('error.' + code)
      if (hasKey('warn.' + code)) return t('warn.' + code)
      return code
    }

    /**
     * Validate the wizard form client-side and build the SPEC §4.9 request body.
     * @returns {{ ok: boolean, request: object|null, fieldErrors: object }}
     */
    function validateWizardForm(t, filters, sort, inventory) {
      const form = filters && typeof filters === 'object' ? filters : defaultWizardFilters()
      const fieldErrors = {}
      const labelOlder = t('sessions.wizard.olderThanDays')
      const labelMinBytes = t('sessions.wizard.minBytes')

      let olderThanDays = 0
      const rawDays = String(form.olderThanDays === undefined ? '0' : form.olderThanDays).trim()
      if (rawDays === '' || !isFinite(Number(rawDays)) || !Number.isInteger(Number(rawDays))) {
        fieldErrors.olderThanDays = t('settings.error.integer', { label: labelOlder })
      } else {
        olderThanDays = Number(rawDays)
        if (olderThanDays < 0 || olderThanDays > WIZARD_MAX_OLDER_DAYS) {
          fieldErrors.olderThanDays = t('settings.error.range', {
            label: labelOlder,
            min: formatNumber(0),
            max: formatNumber(WIZARD_MAX_OLDER_DAYS),
          })
        }
      }

      let minBytes = 0
      const rawMb = String(form.minBytesMb === undefined ? '0' : form.minBytesMb).trim()
      if (rawMb === '' || !isFinite(Number(rawMb))) {
        fieldErrors.minBytes = t('settings.error.number', { label: labelMinBytes })
      } else {
        minBytes = Math.round(Number(rawMb) * BYTES_PER_MB)
        if (minBytes < 0 || minBytes > WIZARD_MAX_MIN_BYTES) {
          fieldErrors.minBytes = t('settings.error.range', {
            label: labelMinBytes,
            min: formatNumber(0),
            max: formatNumber(Math.floor(WIZARD_MAX_MIN_BYTES / BYTES_PER_MB)),
          })
        }
      }

      const archived = form.archived === 'only' || form.archived === 'exclude' ? form.archived : 'all'
      const origin = form.origin === 'root' || form.origin === 'subagent' ? form.origin : 'all'
      const sorted = sort === 'largest' ? 'largest' : 'oldest'

      // A workspace that vanished from the inventory degrades to "any workspace".
      let workspaceId = typeof form.workspaceId === 'string' ? form.workspaceId : ''
      if (workspaceId !== '') {
        const rows = inventory && Array.isArray(inventory.workspaces) ? inventory.workspaces : []
        let known = false
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i] && rows[i].id === workspaceId) { known = true; break }
        }
        if (!known) workspaceId = ''
      }

      const request = {
        filters: {
          olderThanDays: olderThanDays,
          archived: archived,
          minBytes: minBytes,
          origin: origin,
          requireDeletable: form.requireDeletable === true,
        },
        sort: sorted,
        limit: WIZARD_PREVIEW_LIMIT,
      }
      if (workspaceId !== '') request.filters.workspaceId = workspaceId

      return {
        ok: Object.keys(fieldErrors).length === 0,
        request: request,
        fieldErrors: fieldErrors,
      }
    }

    function normalizeInventory(payload) {
      return {
        generatedAt: typeof payload.generatedAt === 'number' ? payload.generatedAt : null,
        dshHome: typeof payload.dshHome === 'string' ? payload.dshHome : null,
        trash: normalizeTrashSummary(payload.trash),
        workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
        sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        truncated: payload.truncated === true,
        // Host-named cap for the session list, so the UI never hardcodes it (SPEC §4.1).
        sessionListCap: typeof payload.sessionListCap === 'number' && isFinite(payload.sessionListCap) && payload.sessionListCap > 0
          ? payload.sessionListCap
          : null,
        // Queued-deletion summary; absent on a pre-defer Host.
        deferred: normalizeDeferredSummary(payload.deferred),
        // Audit overview; absent on a pre-audit Host.
        audit: normalizeAudit(payload.audit),
      }
    }

    function normalizeTrash(payload) {
      return {
        entries: Array.isArray(payload.entries) ? payload.entries : [],
        totals: payload.totals && typeof payload.totals === 'object'
          ? payload.totals
          : { entries: 0, bytes: 0 },
      }
    }

    /** `inventory.trash` including the retention warnings and the Host's suggested purge set. */
    function normalizeTrashSummary(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const suggested = []
      const rawSuggested = Array.isArray(value.suggestedEntryIds) ? value.suggestedEntryIds : []
      for (let i = 0; i < rawSuggested.length; i += 1) {
        if (typeof rawSuggested[i] === 'string' && rawSuggested[i] !== '') suggested.push(rawSuggested[i])
      }
      return {
        root: typeof value.root === 'string' ? value.root : null,
        entries: boundedCount(value.entries, 0),
        bytes: boundedCount(value.bytes, 0),
        oldestMovedAt: typeof value.oldestMovedAt === 'number' && isFinite(value.oldestMovedAt) && value.oldestMovedAt > 0
          ? value.oldestMovedAt
          : null,
        overRetention: value.overRetention === true,
        overCapacity: value.overCapacity === true,
        suggestedEntryIds: suggested,
      }
    }

    /** One audit record from `inventory.audit.recent` (SPEC §4.1/§5.9). */
    function normalizeAuditRecord(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const targets = []
      const rawTargets = Array.isArray(value.targets) ? value.targets : []
      for (let i = 0; i < rawTargets.length; i += 1) {
        const target = normalizeDeferredTarget(rawTargets[i])
        if (target !== null) targets.push(target)
      }
      return {
        at: typeof value.at === 'number' && isFinite(value.at) ? value.at : 0,
        source: value.source === 'startup' ? 'startup' : 'immediate',
        action: typeof value.action === 'string' && value.action !== '' ? value.action : 'unknown',
        mode: value.mode === 'permanent' ? 'permanent' : (value.mode === 'trash' ? 'trash' : null),
        targets: targets,
        status: typeof value.status === 'string' && value.status !== '' ? value.status : 'unknown',
        code: typeof value.code === 'string' && value.code !== '' ? value.code : null,
        bytes: typeof value.bytes === 'number' && isFinite(value.bytes) && value.bytes > 0 ? value.bytes : 0,
      }
    }

    /** `inventory.audit` = `{ enabled, lastStartup, recent }` (newest first, max 10). */
    function normalizeAudit(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { enabled: false, lastStartup: null, recent: [] }
      }
      const rawStartup = value.lastStartup
      const lastStartup = rawStartup && typeof rawStartup === 'object' && !Array.isArray(rawStartup)
        ? {
          at: typeof rawStartup.at === 'number' && isFinite(rawStartup.at) && rawStartup.at > 0 ? rawStartup.at : 0,
          applied: boundedCount(rawStartup.applied, 0),
          skipped: boundedCount(rawStartup.skipped, 0),
          failed: boundedCount(rawStartup.failed, 0),
        }
        : null
      const recent = []
      const rawRecent = Array.isArray(value.recent) ? value.recent : []
      for (let i = 0; i < rawRecent.length && recent.length < AUDIT_RECENT_MAX; i += 1) {
        const record = normalizeAuditRecord(rawRecent[i])
        if (record !== null) recent.push(record)
      }
      return {
        enabled: value.enabled === true,
        lastStartup: lastStartup && lastStartup.at > 0 ? lastStartup : null,
        recent: recent,
      }
    }

    /** Normalize the editable settings object; unknown fields are dropped. */
    function normalizeSettingsValues(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const settings = {}
      for (const field of SETTINGS_BOOLEAN_FIELDS) {
        if (typeof source[field] === 'boolean') settings[field] = source[field]
      }
      const numericFields = Object.keys(SETTINGS_NUMERIC_BOUNDS)
      for (let i = 0; i < numericFields.length; i += 1) {
        const field = numericFields[i]
        if (typeof source[field] === 'number' && isFinite(source[field])) settings[field] = Math.floor(source[field])
      }
      if (typeof source.trashRoot === 'string' && source.trashRoot !== '') settings.trashRoot = source.trashRoot
      return settings
    }

    /** `POST api/cleanup.settings.get` payload. */
    function normalizeSettings(payload) {
      return {
        settings: normalizeSettingsValues(payload && payload.settings),
        defaults: normalizeSettingsValues(payload && payload.defaults),
        persisted: payload ? payload.persisted === true : true,
        persistError: payload && payload.persistError && typeof payload.persistError === 'object' && !Array.isArray(payload.persistError)
          ? {
            code: typeof payload.persistError.code === 'string' ? payload.persistError.code : null,
            message: typeof payload.persistError.message === 'string' ? payload.persistError.message : '',
          }
          : null,
        warnings: Array.isArray(payload && payload.warnings) ? payload.warnings : [],
      }
    }

    function isPlan(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.planId === 'string'
        && Array.isArray(value.items)
        && Array.isArray(value.warnings)
        && Array.isArray(value.blockers)
        && !!value.totals && typeof value.totals === 'object'
    }

    function isTypedConfirmation(value) {
      return !!value && typeof value === 'object'
        && value.kind === 'typed-name'
        && typeof value.expected === 'string'
    }

    function isDeferResult(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.count === 'number' && isFinite(value.count)
        && Array.isArray(value.entryIds)
    }

    function isDeleteResult(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && Array.isArray(value.items)
        && !!value.totals && typeof value.totals === 'object'
    }

    // ------------------------------------------------------- settings helpers

    /** Bytes → the MB text shown in a byte-valued settings input. */
    function bytesToMbText(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '0'
      const mb = bytes / BYTES_PER_MB
      const rounded = Math.round(mb * 1000) / 1000
      return String(rounded)
    }

    /** MB input text → integer bytes, or null when the text is not a finite non-negative number. */
    function mbTextToBytes(text) {
      const raw = typeof text === 'string' ? text.trim() : String(text === undefined ? '' : text)
      if (raw === '') return null
      const value = Number(raw)
      if (!isFinite(value)) return null
      return Math.round(value * BYTES_PER_MB)
    }

    function settingsFieldLabel(t, field) {
      return t('settings.field.' + field)
    }

    /** Build the editable form from an effective settings object. */
    function settingsFormFromValues(settings) {
      const source = settings && typeof settings === 'object' ? settings : {}
      const form = {}
      for (const field of SETTINGS_BOOLEAN_FIELDS) form[field] = source[field] === true
      for (const field of Object.keys(SETTINGS_NUMERIC_BOUNDS)) {
        const value = typeof source[field] === 'number' && isFinite(source[field]) ? source[field] : 0
        form[field] = field === 'trashMaxBytes' || field === 'auditMaxBytes'
          ? bytesToMbText(value)
          : String(Math.floor(value))
      }
      return form
    }

    /** The unit a numeric field is displayed in, for validation messages. */
    function settingsFieldBoundsForDisplay(field) {
      const bounds = SETTINGS_NUMERIC_BOUNDS[field]
      if (!bounds) return null
      if (field === 'trashMaxBytes' || field === 'auditMaxBytes') {
        return { min: Math.ceil(bounds.min / BYTES_PER_MB), max: Math.floor(bounds.max / BYTES_PER_MB), integer: true }
      }
      return { min: bounds.min, max: bounds.max, integer: bounds.integer === true }
    }

    /**
     * Validate the form against SPEC §4.8 and produce the changed-fields patch.
     * @returns {{ patch: object, fieldErrors: object }} localized per-field messages.
     */
    function validateSettingsForm(t, form, effectiveSettings) {
      const source = form && typeof form === 'object' ? form : {}
      const current = effectiveSettings && typeof effectiveSettings === 'object' ? effectiveSettings : {}
      const patch = {}
      const fieldErrors = {}

      for (const field of SETTINGS_BOOLEAN_FIELDS) {
        if (current[field] === undefined) continue
        const wanted = source[field] === true
        if (wanted !== (current[field] === true)) patch[field] = wanted
      }

      const numericFields = Object.keys(SETTINGS_NUMERIC_BOUNDS)
      for (let i = 0; i < numericFields.length; i += 1) {
        const field = numericFields[i]
        const bounds = SETTINGS_NUMERIC_BOUNDS[field]
        const display = settingsFieldBoundsForDisplay(field)
        const label = settingsFieldLabel(t, field)
        const isBytes = field === 'trashMaxBytes' || field === 'auditMaxBytes'
        let value = null
        if (isBytes) {
          value = mbTextToBytes(source[field])
          if (value === null) {
            fieldErrors[field] = t('settings.error.number', { label: label })
            continue
          }
        } else {
          const raw = typeof source[field] === 'string' ? source[field].trim() : String(source[field])
          if (raw === '' || !isFinite(Number(raw))) {
            fieldErrors[field] = t('settings.error.number', { label: label })
            continue
          }
          value = Number(raw)
          if (!Number.isInteger(value)) {
            fieldErrors[field] = t('settings.error.integer', { label: label })
            continue
          }
        }
        if (value < bounds.min || value > bounds.max) {
          fieldErrors[field] = t('settings.error.range', {
            label: label,
            min: formatNumber(display.min),
            max: formatNumber(display.max),
          })
          continue
        }
        if (current[field] === undefined) continue
        if (current[field] !== value) patch[field] = value
      }

      return { patch: patch, fieldErrors: fieldErrors }
    }

    function settingsFormHasChanges(t, form, effectiveSettings) {
      const validation = validateSettingsForm(t, form, effectiveSettings)
      return Object.keys(validation.patch).length > 0
    }

    /**
     * BAD_REQUEST: attach the message to a field control. `labelOverride` lets the
     * cleanup wizard reuse this for its own fields (the settings labels only cover
     * the settings form).
     */
    function settingsFieldError(t, error, field, labelOverride) {
      const details = error && error.details && typeof error.details === 'object' ? error.details : null
      const hostMessage = details && typeof details.message === 'string' && details.message !== ''
        ? details.message
        : (error && typeof error.message === 'string' && error.message !== '' ? error.message : '')
      let label = typeof labelOverride === 'string' && labelOverride !== '' ? labelOverride : t('page.error')
      if (typeof labelOverride !== 'string' || labelOverride === '') {
        if (field && hasKey('settings.field.' + field)) label = settingsFieldLabel(t, field)
        else if (field) label = field
      }
      if (hostMessage !== '') return label + ': ' + hostMessage
      return localizedCode(t, 'error', error && error.code, t('settings.error.saveFailed'))
    }

    /** Wizard-local label for a candidate-filter field named by a host BAD_REQUEST. */
    function wizardFieldLabel(t, field) {
      const keys = {
        olderThanDays: 'sessions.wizard.olderThanDays',
        archived: 'sessions.wizard.archived',
        minBytes: 'sessions.wizard.minBytes',
        minBytesMb: 'sessions.wizard.minBytes',
        workspaceId: 'sessions.wizard.workspace',
        origin: 'sessions.wizard.origin',
        requireDeletable: 'sessions.wizard.requireDeletable',
      }
      if (field && keys[field]) return t(keys[field])
      return field ? String(field) : t('sessions.wizard.title')
    }

    /** `inventory.trash` (retention warning source), tolerating a missing inventory. */
    function trashOf(inventory) {
      return inventory && inventory.trash && typeof inventory.trash === 'object' ? inventory.trash : null
    }

    /** Does the retention banner need the configured limits (settings.get) to explain itself? */
    function trashNeedsSettings(trash) {
      return !!(trash && (trash.overRetention === true || trash.overCapacity === true))
    }

    // ---------------------------------------------------------- audit helpers

    function auditActionText(t, action) {
      const value = typeof action === 'string' && action !== '' ? action : 'unknown'
      const candidates = ['audit.action.' + value, 'audit.action.unknown']
      for (let i = 0; i < candidates.length; i += 1) {
        if (hasKey(candidates[i])) return t(candidates[i])
      }
      return t('audit.action.unknown')
    }

    function auditStatusText(t, status) {
      const value = typeof status === 'string' && status !== '' ? status : 'unknown'
      const key = 'audit.status.' + value
      if (hasKey(key)) return t(key)
      return t('audit.status.unknown')
    }

    function auditNoticeStorage() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') return localStorage
      } catch (error) {
        /* storage can throw in private modes; the notice then shows every load */
      }
      return null
    }

    function auditNoticeAcknowledged(at) {
      if (typeof at !== 'number' || at <= 0) return false
      try {
        const storage = auditNoticeStorage()
        if (storage === null) return false
        return storage.getItem(AUDIT_NOTICE_STORAGE_KEY) === String(at)
      } catch (error) {
        return false
      }
    }

    function acknowledgeAuditNotice(at) {
      if (typeof at !== 'number' || at <= 0) return
      try {
        const storage = auditNoticeStorage()
        if (storage !== null && typeof storage.setItem === 'function') storage.setItem(AUDIT_NOTICE_STORAGE_KEY, String(at))
      } catch (error) {
        /* a storage failure only means the notice is shown again next time */
      }
    }

    /** The one-time startup notice only for a start within the last 24 h. */
    function auditStartupNoticeVisible(audit) {
      const startup = audit && audit.lastStartup ? audit.lastStartup : null
      if (!startup || typeof startup.at !== 'number' || startup.at <= 0) return null
      if (Date.now() - startup.at > AUDIT_NOTICE_WINDOW_MS) return null
      if (auditNoticeAcknowledged(startup.at)) return null
      if (startup.applied + startup.skipped + startup.failed === 0) return null
      return startup
    }

    /** Whole days an entry has been in the trash (0 when unknown / just moved). */
    function trashAgeDays(oldestMovedAt) {
      if (typeof oldestMovedAt !== 'number' || !isFinite(oldestMovedAt) || oldestMovedAt <= 0) return 0
      const age = Date.now() - oldestMovedAt
      return age > 0 ? Math.floor(age / 86400000) : 0
    }

    /** One audit target row label, using the same resolution as queued entries. */
    function auditTargetsLabel(t, catalog, workspaceLabels, targets, max) {
      const list = Array.isArray(targets) ? targets : []
      const shown = list.slice(0, max)
      const hidden = list.length - shown.length
      const parts = []
      for (let i = 0; i < shown.length; i += 1) {
        parts.push(deferredTargetLabel(t, catalog, workspaceLabels, shown[i]))
      }
      if (hidden > 0) parts.push(plural(t, 'deferred.moreTargets', hidden))
      return parts.join(' · ')
    }

    // ------------------------------------------------------------------- HTTP

    /**
     * POST JSON and normalize every inability to read the envelope into a
     * transport value (SPEC §8: non-JSON body, network failure and `{ok:false}`
     * are three distinct failures). Abort errors are re-thrown untouched.
     */
    async function request(path, payload, signal) {
      if (typeof fetch !== 'function') return { transport: 'network' }
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          signal: signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        return { transport: 'network' }
      }
      let body
      try {
        body = await response.json()
      } catch (error) {
        if (isAbortError(error)) throw error
        return { transport: 'badResponse' }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') {
        return { transport: 'badResponse' }
      }
      return body
    }

    function toApiError(envelope) {
      if (envelope && envelope.transport) return { transport: envelope.transport }
      const error = envelope && envelope.error && typeof envelope.error === 'object' ? envelope.error : {}
      const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details
        : null
      return {
        code: typeof error.code === 'string' ? error.code : null,
        message: typeof error.message === 'string' ? error.message : '',
        details: details,
      }
    }

    /** Localize a code, falling back to the Host message only for unknown codes. */
    function localizedCode(t, prefix, code, fallbackMessage) {
      if (typeof code === 'string' && code !== '') {
        const key = prefix + '.' + code
        if (hasKey(key)) return t(key)
      }
      if (typeof fallbackMessage === 'string' && fallbackMessage !== '') return fallbackMessage
      return t('error.unknown')
    }

    /**
     * Localize one plan warning. Count-bearing warnings (a `{count}` placeholder in the
     * dictionary) take the number from the payload when present, else from the Host
     * message's first integer (the Host messages carry exactly one count); when no
     * number is available the Host message is shown rather than a literal placeholder.
     */
    function warningText(t, warning) {
      const code = warning && typeof warning.code === 'string' ? warning.code : ''
      const message = warning && typeof warning.message === 'string' ? warning.message : ''
      if (code === '') return message !== '' ? message : t('error.unknown')
      const key = 'warn.' + code
      if (!hasKey(key)) return localizedCode(t, 'warn', code, message)
      const template = en[key]
      if (typeof template !== 'string' || template.indexOf('{count}') === -1) return t(key)
      let count = null
      if (warning && typeof warning.count === 'number' && isFinite(warning.count)) count = warning.count
      else if (warning && warning.details && typeof warning.details.count === 'number' && isFinite(warning.details.count)) count = warning.details.count
      else if (message !== '') {
        const found = message.match(/\d[\d,]*/)
        if (found !== null) {
          const parsed = Number(found[0].split(',').join(''))
          if (isFinite(parsed)) count = parsed
        }
      }
      if (count === null) return message !== '' ? message : t(key)
      return t(key, { count: formatNumber(count) })
    }

    function apiErrorText(t, error) {
      if (!error) return t('error.unknown')
      if (error.transport === 'network') return t('error.network')
      if (error.transport === 'badResponse') return t('error.badResponse')
      return localizedCode(t, 'error', error.code, error.message)
    }

    function apiErrorCode(error) {
      if (!error || error.transport) return null
      return typeof error.code === 'string' && error.code !== '' ? error.code : null
    }

    // ------------------------------------------------------------- stylesheet

    const STYLE_ATTR = 'data-dsh-cleanup-styles'

    const STYLE_TEXT = [
      '.dsh-cleanup-page{display:flex;flex-direction:column;gap:14px;padding-top:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dsh-cleanup-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dsh-cleanup-page-heading{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsh-cleanup-page-title{margin:0;font-size:15px;line-height:22px;font-weight:600}',
      '.dsh-cleanup-page-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-cleanup-page-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}',
      '.dsh-cleanup-page-foot{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}',
      '.dsh-cleanup-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-cleanup-tab{appearance:none;border:0;background:transparent;font:inherit;font-size:13px;line-height:20px;padding:6px 10px;margin-bottom:-1px;color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;cursor:pointer;border-radius:6px 6px 0 0}',
      '.dsh-cleanup-tab:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}',
      '.dsh-cleanup-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}',
      '.dsh-cleanup-panel{display:flex;flex-direction:column;gap:10px;min-height:120px}',
      '.dsh-cleanup-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex-wrap:wrap}',
      '.dsh-cleanup-list{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cleanup-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.dsh-cleanup-item-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dsh-cleanup-item-head{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}',
      '.dsh-cleanup-item-title{font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dsh-cleanup-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px}',
      '.dsh-cleanup-item-actions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}',
      '.dsh-cleanup-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dsh-cleanup-size{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-cleanup-sep{color:var(--dsw-alias-state-idle-primary)}',
      '.dsh-cleanup-badge{flex:none;display:inline-flex;align-items:center;font-size:11px;line-height:16px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-cleanup-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent)}',
      '.dsh-cleanup-badge-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}',
      '.dsh-cleanup-badge-success{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}',
      '.dsh-cleanup-badge-brand{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}',
      '.dsh-cleanup-badge-idle{color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-check{accent-color:var(--dsw-alias-brand-primary);flex:none;margin:0;width:14px;height:14px;cursor:pointer}',
      '.dsh-cleanup-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12.5px;line-height:18px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}',
      '.dsh-cleanup-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
      '.dsh-cleanup-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-cleanup-btn:disabled{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l1);cursor:not-allowed;background:transparent}',
      '.dsh-cleanup-btn-sm{padding:3px 10px;font-size:12px;line-height:17px}',
      '.dsh-cleanup-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-btn-ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dsh-cleanup-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
      '.dsh-cleanup-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}',
      '.dsh-cleanup-btn-danger:disabled{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l1);background:transparent}',
      '.dsh-cleanup-btn-accent{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      '.dsh-cleanup-banner{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cleanup-banner-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent)}',
      '.dsh-cleanup-banner-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}',
      '.dsh-cleanup-banner-text{flex:1;min-width:0}',
      '.dsh-cleanup-state{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-cleanup-state-title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-cleanup-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}',
      '.dsh-cleanup-batchbar{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;flex-wrap:wrap}',
      '.dsh-cleanup-batchbar-text{flex:1;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.dsh-cleanup-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-cleanup-toolbar-field{display:flex;align-items:center;gap:5px}',
      '.dsh-cleanup-select{font:inherit;font-size:12.5px;line-height:18px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dsh-cleanup-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-cleanup-deferred{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cleanup-deferred-banner{align-items:center}',
      '.dsh-cleanup-deferred-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dsh-cleanup-deferred-entry{display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;flex-wrap:wrap}',
      '.dsh-cleanup-deferred-entry-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dsh-cleanup-deferred-lastrun{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-deferred-lastrun-block{display:flex;flex-direction:column;gap:4px}',
      '.dsh-cleanup-deferred-lastrun-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-cleanup-deferred-listsum{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-deferred-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dsh-cleanup-deferred-result{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.dsh-cleanup-deferred-result-head{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap}',
      '.dsh-cleanup-deferred-result-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);min-width:0}',
      '.dsh-cleanup-defer-hint{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cleanup-defer-hint-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-cleanup-done-paths{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
      '.dsh-cleanup-done-path{overflow-wrap:anywhere}',
      '.dsh-cleanup-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;overscroll-behavior:contain}',
      // A dialog opened from the settings page renders inside the sheet, i.e. inside the
      // sheet's fixed, z-index-1000 stacking context, where its panel is z-index 1. 60 keeps
      // the review above every sheet surface without ever competing with the sheet itself.
      '.dsh-cleanup-overlay-inline{z-index:60}',
      '.dsh-cleanup-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-base);opacity:.72}',
      '.dsh-cleanup-dialog{position:relative;z-index:1;display:flex;flex-direction:column;width:600px;max-width:100%;max-height:calc(100vh - 48px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);font-size:13px;line-height:20px;overflow:hidden}',
      '.dsh-cleanup-dialog:focus{outline:none}',
      '.dsh-cleanup-dialog-head{display:flex;flex-direction:column;gap:3px;padding:16px 20px 10px}',
      '.dsh-cleanup-dialog-title{margin:0;font-size:15px;line-height:22px;font-weight:600}',
      '.dsh-cleanup-dialog-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}',
      '.dsh-cleanup-dialog-body{flex:1;min-height:200px;overflow:auto;padding:2px 20px 14px;display:flex;flex-direction:column;gap:14px}',
      '.dsh-cleanup-dialog-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-cleanup-dialog-footer .dsh-cleanup-progress{margin-right:auto}',
      '.dsh-cleanup-progress{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-cleanup-section{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cleanup-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-section-title-error{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-cleanup-notices{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.dsh-cleanup-notice{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cleanup-notice-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent)}',
      '.dsh-cleanup-notice-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent)}',
      '.dsh-cleanup-notice-mark{flex:none;width:14px;text-align:center;font-weight:600}',
      '.dsh-cleanup-totals{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsh-cleanup-muted{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}',
      '.dsh-cleanup-modes{display:flex;align-items:flex-start;gap:8px}',
      '.dsh-cleanup-mode{position:relative;flex:1;min-width:0;display:flex}',
      '.dsh-cleanup-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.dsh-cleanup-mode-card{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:pointer;background:transparent;min-width:0}',
      '.dsh-cleanup-mode-active .dsh-cleanup-mode-card{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}',
      '.dsh-cleanup-mode-disabled .dsh-cleanup-mode-card{cursor:not-allowed;opacity:.62}',
      '.dsh-cleanup-sr:focus-visible+.dsh-cleanup-mode-card{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-cleanup-mode-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dsh-cleanup-radio{flex:none;width:12px;height:12px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;margin-top:3px}',
      '.dsh-cleanup-mode-card{flex-direction:row;align-items:flex-start;gap:8px}',
      '.dsh-cleanup-mode-card .dsh-cleanup-mode-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-cleanup-mode-active .dsh-cleanup-radio{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 2px var(--dsw-alias-bg-layer-1)}',
      '.dsh-cleanup-mode-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-checkrow{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      // Review rows: one checkbox per reviewed target; the plan items that ride along with it
      // (subagent logs, folder Sessions) collapse underneath instead of flooding the list.
      '.dsh-cleanup-inline-action{background:none;border:none;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer}',
      '.dsh-cleanup-inline-action:disabled{opacity:.5;cursor:default}',
      '.dsh-cleanup-select-actions{display:flex;align-items:center;gap:12px;margin-left:auto}',
      '.dsh-cleanup-select-required{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-cleanup-target-list{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cleanup-target-block{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh-cleanup-target{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;min-width:0}',
      '.dsh-cleanup-target-off{opacity:.55}',
      '.dsh-cleanup-target-check{accent-color:var(--dsw-alias-brand-primary);flex:none;width:14px;height:14px;margin:2px 0 0;cursor:pointer}',
      '.dsh-cleanup-target-mark{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.dsh-cleanup-target-children{display:flex;flex-direction:column;gap:6px;padding-left:24px}',
      '.dsh-cleanup-target-more{align-self:flex-start;background:none;border:none;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline}',
      '.dsh-cleanup-target-more:disabled{opacity:.6;cursor:default;text-decoration:none}',
      '.dsh-cleanup-target-child-list{display:flex;flex-direction:column;gap:6px}',
      '.dsh-cleanup-session-group{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh-cleanup-field{display:flex;flex-direction:column;gap:5px}',
      '.dsh-cleanup-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dsh-cleanup-input{font:inherit;font-size:13px;line-height:20px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}',
      '.dsh-cleanup-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-cleanup-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}',
      '.dsh-cleanup-field-error{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-cleanup-spinner{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-cleanup-spin .8s linear infinite}',
      '@keyframes dsh-cleanup-spin{to{transform:rotate(360deg)}}',
      '.dsh-cleanup-skeleton{display:flex;flex-direction:column;gap:10px;padding:6px 0}',
      '.dsh-cleanup-skeleton-line{height:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);animation:dsh-cleanup-pulse 1.4s ease-in-out infinite}',
      '.dsh-cleanup-skeleton-line:nth-child(2){width:82%}',
      '.dsh-cleanup-skeleton-line:nth-child(3){width:64%}',
      '@keyframes dsh-cleanup-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
      '.dsh-cleanup-done{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cleanup-done-title{font-size:13.5px;line-height:20px;font-weight:600;color:var(--dsw-alias-state-success-primary)}',
      '.dsh-cleanup-failed{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cleanup-failed-title{font-size:13.5px;line-height:20px;font-weight:600;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-cleanup-settings{display:flex;flex-direction:column;gap:14px}',
      '.dsh-cleanup-group{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.dsh-cleanup-setting{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}',
      '.dsh-cleanup-setting-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dsh-cleanup-setting-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dsh-cleanup-setting-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-setting-control{display:flex;align-items:center;gap:6px;flex:none}',
      '.dsh-cleanup-input-sm{width:140px}',
      '.dsh-cleanup-status-success{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
      '.dsh-cleanup-status-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}',
      '.dsh-cleanup-retention{flex-direction:column;align-items:stretch}',
      '.dsh-cleanup-retention .dsh-cleanup-item-actions{justify-content:flex-start}',
      '.dsh-cleanup-deferred-retained{display:flex;flex-direction:column;gap:6px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-cleanup-deferred-banner .dsh-cleanup-banner-text{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}',
      '.dsh-cleanup-wizard{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.dsh-cleanup-wizard:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-cleanup-wizard-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.dsh-cleanup-wizard-title{margin:0;font-size:13px;line-height:20px;font-weight:600}',
      '.dsh-cleanup-wizard-filters{display:flex;flex-wrap:wrap;gap:10px 14px;margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-width:0}',
      '.dsh-cleanup-wizard-legend{padding:0 4px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-wizard-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-cleanup-wizard-field-label{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-wizard-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-wizard-toggle{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:18px;cursor:pointer}',
      '.dsh-cleanup-wizard-capnote{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cleanup-wizard-result-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh-cleanup-wizard-summary{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsh-cleanup-wizard-warn{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-cleanup-wizard-selectbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px}',
      '.dsh-cleanup-wizard-selectall{display:flex;align-items:center;gap:8px;cursor:pointer}',
      '.dsh-cleanup-wizard-results{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dsh-cleanup-wizard-list{display:flex;flex-direction:column;gap:6px;max-height:360px;overflow:auto;min-width:0}',
      '.dsh-cleanup-wizard-row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsh-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.dsh-cleanup-wizard-row-blocked{opacity:.72}',
      '.dsh-cleanup-wizard-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dsh-cleanup-wizard-blockers{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-cleanup-wizard-footer{display:flex;justify-content:flex-end;gap:8px}',
      '.dsh-cleanup-progress-items{font-variant-numeric:tabular-nums}',
      '.dsh-cleanup-progress-elapsed{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '@media (max-width:560px){.dsh-cleanup-modes{flex-direction:column}.dsh-cleanup-page-head{flex-direction:column;align-items:stretch}}',
    ].join('')

    /**
     * Install the plugin stylesheet once and return its remover. A duplicate from a
     * crashed previous load is replaced rather than stacked.
     */
    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return function () { }
      const previous = document.querySelectorAll('style[' + STYLE_ATTR + ']')
      for (let i = 0; i < previous.length; i += 1) {
        if (previous[i].parentNode) previous[i].parentNode.removeChild(previous[i])
      }
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    // -------------------------------------------------------------- primitives

    function Spinner() {
      return h('span', { className: 'dsh-cleanup-spinner', 'aria-hidden': 'true' })
    }

    function Skeleton(props) {
      const lines = props && props.lines ? props.lines : 3
      const children = []
      for (let i = 0; i < lines; i += 1) {
        children.push(h('div', { key: 'line-' + i, className: 'dsh-cleanup-skeleton-line' }))
      }
      return h('div', { className: 'dsh-cleanup-skeleton', 'aria-hidden': 'true' }, children)
    }

    function Badge(props) {
      return h('span', {
        className: 'dsh-cleanup-badge' + (props.tone ? ' dsh-cleanup-badge-' + props.tone : ''),
        title: props.title,
      }, props.children)
    }

    function Sep() {
      return h('span', { className: 'dsh-cleanup-sep', 'aria-hidden': 'true' }, '·')
    }

    /** Focus trap used by the modal: Tab wraps inside the dialog. */
    function trapFocus(event, container) {
      if (!container) return
      const candidates = container.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      )
      const focusable = Array.prototype.filter.call(candidates, function (node) {
        return node.offsetParent !== null || node === document.activeElement
      })
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      // The dialog container itself is tabbable (tabIndex -1) but is not in the
      // focusable list, so a first Tab from it must still land inside the dialog.
      const inside = focusable.indexOf(active) !== -1
      if (event.shiftKey) {
        if (active === first || !inside) {
          event.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    /** One summary row out of `ctx.sessions.list`'s `SessionListState`, or null. */
    function catalogEntry(catalog, sessionId) {
      if (!catalog || typeof catalog !== 'object') return null
      if (!catalog.byId || typeof catalog.byId !== 'object') return null
      const entry = catalog.byId[sessionId]
      return entry && typeof entry === 'object' ? entry : null
    }

    function catalogDisplayTitle(catalog, sessionId) {
      const entry = catalogEntry(catalog, sessionId)
      if (entry && typeof entry.displayTitle === 'string' && entry.displayTitle !== '') return entry.displayTitle
      return null
    }

    /**
     * Human session label. Priority (per Lead review): a displayTitle already
     * captured with the target (context menu) → `ctx.sessions.list` displayTitle
     * → cwd basename → short id. The catalog is the same authority the sidebar
     * shows, so page rows and review rows agree with it.
     */
    function resolveSessionLabel(t, catalog, session) {
      const id = session && typeof session.id === 'string' ? session.id : ''
      if (session && typeof session.displayTitle === 'string' && session.displayTitle !== '') return session.displayTitle
      const fromCatalog = catalogDisplayTitle(catalog, id)
      if (fromCatalog !== null) return fromCatalog
      const entry = catalogEntry(catalog, id)
      const cwd = typeof session?.cwd === 'string' && session.cwd !== ''
        ? session.cwd
        : (entry && typeof entry.cwd === 'string' ? entry.cwd : '')
      const base = baseName(cwd)
      if (base !== '') return base
      return shortId(id) || t('session.untitled')
    }

    /** Newest-first sort key: catalog `updatedAt` when present, else inventory `createdAt`. */
    function sessionSortValue(catalog, session) {
      const entry = catalogEntry(catalog, session && session.id)
      if (entry && typeof entry.updatedAt === 'number' && isFinite(entry.updatedAt) && entry.updatedAt > 0) {
        return entry.updatedAt
      }
      return session && typeof session.createdAt === 'number' && isFinite(session.createdAt) ? session.createdAt : 0
    }

    /** Measured size for a session row, or null while unmeasured. */
    function sessionMeasuredBytes(state, session) {
      if (!state || !state.measured || !state.measured.sessions) return null
      const measured = state.measured.sessions[session && session.id]
      return measured && typeof measured.bytes === 'number' && isFinite(measured.bytes) ? measured.bytes : null
    }

    /**
     * Sessions-tab comparator. Newest/oldest use the same key the page has
     * always shown; largest sorts measured sizes first and leaves unmeasured rows
     * last (they are not comparable), newest-first among themselves.
     */
    function compareSessionRows(catalog, state, sort, left, right) {
      if (sort === 'oldest' || sort === 'newest') {
        const leftValue = sessionSortValue(catalog, left)
        const rightValue = sessionSortValue(catalog, right)
        const leftKnown = leftValue > 0
        const rightKnown = rightValue > 0
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
        if (leftKnown && leftValue !== rightValue) {
          return sort === 'oldest' ? leftValue - rightValue : rightValue - leftValue
        }
        return String(left && left.id).localeCompare(String(right && right.id))
      }
      const leftBytes = sessionMeasuredBytes(state, left)
      const rightBytes = sessionMeasuredBytes(state, right)
      const leftKnown = leftBytes !== null
      const rightKnown = rightBytes !== null
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
      if (leftKnown && leftBytes !== rightBytes) return rightBytes - leftBytes
      return compareSessionRows(catalog, state, 'newest', left, right)
    }

    /**
     * Can this blocked plan be queued for the next DSH start? Only when it has at
     * least one blocker and EVERY blocker is one a restart clears
     * (`SESSION_LIVE` / `SESSION_RUNNING`). A protected path or a missing
     * directory would still be protected/missing next start, so queueing it would
     * silently fail again and must not be offered.
     * @returns {{ canDefer: boolean, sessionHeld: number, other: number }}
     */
    function planDeferrability(plan) {
      const blockers = plan && Array.isArray(plan.blockers) ? plan.blockers : []
      let sessionHeld = 0
      let other = 0
      for (let i = 0; i < blockers.length; i += 1) {
        const code = blockers[i] && typeof blockers[i].code === 'string' ? blockers[i].code : ''
        if (code !== '' && DEFERRABLE_BLOCKER_CODES[code] === true) sessionHeld += 1
        else other += 1
      }
      return {
        canDefer: blockers.length > 0 && sessionHeld > 0 && other === 0,
        sessionHeld: sessionHeld,
        other: other,
      }
    }

    /** Request body for `POST api/cleanup.defer` (task-9 protocol). */
    function deferRequestBody(state, plan) {
      // The reviewed plan is the authority: `state.targets` holds every row the dialog can show,
      // while the checkboxes may have narrowed what is actually planned. A plan without targets is
      // unreadable, never a reason to fall back to rows the user un-checked (SPEC §9).
      const planned = plan && Array.isArray(plan.targets) ? plan.targets : []
      const body = {
        targets: planned.map(function (target) { return { kind: target.kind, id: target.id } }),
        mode: state.mode === 'permanent' ? 'permanent' : 'trash',
        includeSessions: state.includeSessions === true,
        includeDescendants: state.includeDescendants === true,
      }
      // A permanent workspace-dir plan can carry a typed confirmation; the Host
      // validates the same text when it applies the queued deletion at next start.
      const confirmation = plan && isTypedConfirmation(plan.confirmation) ? plan.confirmation : null
      if (confirmation !== null) body.confirmationText = state.typed.trim()
      return body
    }

    /** Localized mode label for a queued deletion entry. */
    function deferredModeText(t, mode) {
      return t(mode === 'permanent' ? 'dialog.mode.perm' : 'dialog.mode.trash')
    }

    /** workspace id → human label from the inventory rows (title, else path basename). */
    function deferredWorkspaceLabels(inventory) {
      const labels = {}
      const workspaces = inventory && Array.isArray(inventory.workspaces) ? inventory.workspaces : []
      for (let i = 0; i < workspaces.length; i += 1) {
        const row = workspaces[i]
        if (!row || typeof row.id !== 'string' || row.id === '') continue
        const path = typeof row.path === 'string' ? row.path : ''
        const label = typeof row.title === 'string' && row.title !== '' ? row.title : baseName(path)
        labels[row.id] = label !== '' ? label : null
      }
      return labels
    }

    /**
     * Label for one queued target: session titles come from the live catalog, workspace
     * titles from the inventory; the short id is only the last resort for a target that
     * no longer exists (F5).
     */
    function deferredTargetLabel(t, catalog, workspaceLabels, target) {
      if (!target || typeof target !== 'object') return t('common.none')
      const id = typeof target.id === 'string' ? target.id : ''
      if (target.kind === 'workspace') {
        const known = workspaceLabels && Object.prototype.hasOwnProperty.call(workspaceLabels, id) ? workspaceLabels[id] : null
        if (typeof known === 'string' && known !== '') return known
        return t('deferred.workspaceTarget', { id: shortId(id) })
      }
      return resolveSessionLabel(t, catalog, { id: id })
    }

    /** Archived filter: all | only archived | hide archived. */
    function sessionMatchesFilter(session, filter) {
      if (filter === 'archived') return session && session.archived === true
      if (filter === 'active') return !(session && session.archived === true)
      return true
    }

    /**
     * The workspace a Session belongs to. A subagent log usually carries no membership of its own, so
     * it inherits through its parent chain; without that, every subagent log would be listed under
     * `未分组` even when its parent lives in a registered workspace (SPEC §10).
     */
    function sessionWorkspaceOf(session, byId, seen) {
      if (!session || typeof session !== 'object') return ''
      const direct = typeof session.workspaceId === 'string' ? session.workspaceId : ''
      if (direct !== '') return direct
      const parentId = typeof session.parentSessionId === 'string' ? session.parentSessionId : ''
      if (parentId === '') return ''
      const visited = seen || Object.create(null)
      if (visited[session.id] === true) return ''
      visited[session.id] = true
      const parent = byId[parentId]
      // A log whose parent is gone stays ungrouped rather than disappearing.
      if (!parent) return ''
      return sessionWorkspaceOf(parent, byId, visited)
    }

    /** Does an effective workspace id pass the Sessions-tab workspace filter? */
    function workspaceMatchesFilter(effectiveId, workspace) {
      if (workspace === SESSION_WORKSPACE_ANY) return true
      const id = typeof effectiveId === 'string' ? effectiveId : ''
      if (workspace === SESSION_WORKSPACE_UNGROUPED) return id === ''
      return id === workspace
    }

    function rowTitle(t, row) {
      if (typeof row.title === 'string' && row.title !== '') return row.title
      const base = baseName(row.path)
      return base !== '' ? base : t('dialog.items.workspace')
    }

    function renderErrorBlock(t, error, onRetry) {
      return h('div', { className: 'dsh-cleanup-state', role: 'alert' },
        h('div', { className: 'dsh-cleanup-state-title' }, t('page.error')),
        h('div', null, apiErrorText(t, error)),
        h('button', { type: 'button', className: 'dsh-cleanup-btn', onClick: onRetry }, t('action.retry')),
      )
    }

    // ------------------------------------------------------------ review body

    /**
     * Review-row title: plan title → catalog displayTitle (sessions) → path/cwd
     * basename → short id. Mirrors the settings page and the sidebar labels.
     */
    function planItemTitle(t, item, catalog) {
      const isWorkspace = item.kind === 'workspace-dir'
      if (typeof item.title === 'string' && item.title !== '') return item.title
      if (isWorkspace) {
        const workspaceBase = baseName(item.path)
        return workspaceBase !== '' ? workspaceBase : t('dialog.items.workspace')
      }
      const fromCatalog = catalogDisplayTitle(catalog, item.id)
      if (fromCatalog !== null) return fromCatalog
      const entry = catalogEntry(catalog, item.id)
      const cwd = entry && typeof entry.cwd === 'string' ? entry.cwd : ''
      const cwdBase = baseName(cwd)
      if (cwdBase !== '') return cwdBase
      const short = shortId(item.id)
      return short !== '' ? short : t('dialog.items.session')
    }

    function renderPlanItem(t, item, catalog) {
      const isWorkspace = item.kind === 'workspace-dir'
      const badgeText = isWorkspace
        ? t('dialog.items.workspace')
        : (item.isDescendant === true ? t('dialog.items.subagent') : t('dialog.items.session'))
      const title = planItemTitle(t, item, catalog)
      const bytes = typeof item.bytes === 'number' && isFinite(item.bytes) ? item.bytes : 0
      const sizeText = (item.truncated === true ? '≥ ' : '') + formatBytes(bytes)
      const files = plural(t, 'count.file', item.files)
      const dirs = plural(t, 'count.dir', item.dirs)
      const meta = isWorkspace
        ? t('dialog.item.meta', { size: sizeText, files: files, dirs: dirs })
        : t('dialog.item.metaFiles', { size: sizeText, files: files })
      const path = typeof item.path === 'string' ? item.path : ''
      return h('div', { className: 'dsh-cleanup-item', key: String(item.kind) + ':' + String(item.id) },
        h('div', { className: 'dsh-cleanup-item-main' },
          h('div', { className: 'dsh-cleanup-item-head' },
            h(Badge, { tone: isWorkspace ? 'brand' : 'idle' }, badgeText),
            h('span', { className: 'dsh-cleanup-item-title', title: title }, title),
          ),
          path !== '' ? h('div', { className: 'dsh-cleanup-path', title: path }, middleEllipsis(path, 72)) : null,
          h('div', { className: 'dsh-cleanup-item-meta', title: item.truncated === true ? t('dialog.items.truncated') : undefined }, meta),
        ),
      )
    }

    /**
     * Assign every plan item to the reviewed row it belongs to (SPEC §9): a Session target owns the
     * plan item of the same id plus every subagent descendant reachable through `parentSessionId`;
     * a workspace target owns its directory item plus the Sessions swept in by the folder predicate
     * (§4.3 `includeSessions`). Anything unclaimed is listed last instead of disappearing.
     */
    function groupPlanItems(items, targets) {
      const workspaceItems = []
      const sessionItems = []
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]
        if (item.kind === 'workspace-dir') workspaceItems.push(item)
        else if (item.kind === 'session') sessionItems.push(item)
      }
      const sessionById = Object.create(null)
      for (let i = 0; i < sessionItems.length; i += 1) sessionById[sessionItems[i].id] = sessionItems[i]
      const groups = []
      const sessionGroups = Object.create(null)
      const workspaceGroups = Object.create(null)
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i]
        const group = { target: target, main: null, children: [], swept: [] }
        if (target.kind === 'workspace') {
          for (let j = 0; j < workspaceItems.length; j += 1) {
            if (workspaceItems[j].id === target.id) { group.main = workspaceItems[j]; break }
          }
          workspaceGroups[target.id] = group
        } else {
          group.main = sessionById[target.id] || null
          sessionGroups[target.id] = group
        }
        groups.push(group)
      }
      const leftovers = []
      for (let i = 0; i < sessionItems.length; i += 1) {
        const item = sessionItems[i]
        if (sessionGroups[item.id] !== undefined) continue
        // Walk up the parent chain: a subagent Session belongs to the nearest reviewed ancestor.
        let owner = null
        let cursor = item
        const seen = Object.create(null)
        while (owner === null) {
          const parentId = typeof cursor.parentSessionId === 'string' ? cursor.parentSessionId : ''
          if (parentId === '') break
          if (sessionGroups[parentId] !== undefined) { owner = sessionGroups[parentId]; break }
          if (seen[parentId] === true) break
          seen[parentId] = true
          cursor = sessionById[parentId]
          if (cursor === undefined) break
        }
        if (owner !== null) { owner.children.push(item); continue }
        const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : ''
        if (workspaceId !== '' && workspaceGroups[workspaceId] !== undefined) {
          workspaceGroups[workspaceId].swept.push(item)
          continue
        }
        leftovers.push(item)
      }
      return { groups: groups, leftovers: leftovers }
    }

    /** One reviewed row: checkbox, badge, title, path and size (or "not selected"). */
    function renderTargetRow(context) {
      const t = context.t
      const group = context.group
      const item = group.main
      const isWorkspace = group.target.kind === 'workspace'
      let title
      if (item !== null) title = planItemTitle(t, item, context.catalog)
      else if (typeof group.target.title === 'string' && group.target.title !== '') title = group.target.title
      else if (typeof group.target.path === 'string' && group.target.path !== '') title = baseName(group.target.path)
      else title = shortId(group.target.id)
      const bytes = item && typeof item.bytes === 'number' && isFinite(item.bytes) ? item.bytes : 0
      const sizeText = (item && item.truncated === true ? '≥ ' : '') + formatBytes(bytes)
      const files = plural(t, 'count.file', item ? item.files : 0)
      const dirs = plural(t, 'count.dir', item ? item.dirs : 0)
      const meta = item === null
        ? t(context.pending === true ? 'dialog.select.pending' : 'dialog.select.excluded')
        : (isWorkspace
          ? t('dialog.item.meta', { size: sizeText, files: files, dirs: dirs })
          : t('dialog.item.metaFiles', { size: sizeText, files: files }))
      const path = item && typeof item.path === 'string' && item.path !== ''
        ? item.path
        : (typeof group.target.path === 'string' ? group.target.path : '')
      return h('label', {
        className: 'dsh-cleanup-target' + (context.checked ? '' : ' dsh-cleanup-target-off'),
        key: 'row:' + targetKey(group.target),
      },
        context.selectable
          ? h('input', {
            type: 'checkbox',
            className: 'dsh-cleanup-target-check',
            checked: context.checked,
            disabled: context.disabled,
            onChange: function (event) { context.onToggle(targetKey(group.target), event.target.checked) },
          })
          : h('span', { className: 'dsh-cleanup-target-mark', 'aria-hidden': 'true' }, '·'),
        h('div', { className: 'dsh-cleanup-item-main' },
          h('div', { className: 'dsh-cleanup-item-head' },
            h(Badge, { tone: isWorkspace ? 'brand' : 'idle' }, isWorkspace ? t('dialog.items.workspace') : t('dialog.items.session')),
            h('span', { className: 'dsh-cleanup-item-title', title: title }, title),
          ),
          path !== '' ? h('div', { className: 'dsh-cleanup-path', title: path }, middleEllipsis(path, 72)) : null,
          h('div', { className: 'dsh-cleanup-item-meta' }, meta),
        ),
      )
    }

    /** Collapsible list of the items that ride along with one reviewed row (SPEC §9). */
    function renderTargetChildren(context) {
      const t = context.t
      const items = context.items
      if (items.length === 0) return null
      return h('div', { className: 'dsh-cleanup-target-children' },
        h('button', {
          type: 'button',
          className: 'dsh-cleanup-target-more',
          'aria-expanded': context.expanded ? 'true' : 'false',
          'aria-controls': context.listId,
          disabled: context.disabled,
          onClick: context.onToggleExpanded,
        },
          (context.expanded ? t('dialog.groups.hide') : t('dialog.groups.show')) + ' · ' + plural(t, context.summaryKey, items.length),
        ),
        h('div', { id: context.listId, className: 'dsh-cleanup-target-child-list' },
          context.expanded
            ? items.map(function (item) { return renderPlanItem(t, item, context.catalog) })
            : null),
      )
    }

    function renderModeOption(t, options) {
      const mode = options.mode
      const active = options.active
      const blocked = options.blocked
      const disabled = options.disabled
      return h('label', {
        key: mode,
        className: 'dsh-cleanup-mode'
          + (active ? ' dsh-cleanup-mode-active' : '')
          + (blocked ? ' dsh-cleanup-mode-disabled' : ''),
      },
        h('input', {
          className: 'dsh-cleanup-sr',
          type: 'radio',
          name: options.groupName,
          value: mode,
          checked: active,
          disabled: disabled || blocked,
          onChange: function () { options.onChange(mode) },
        }),
        h('span', { className: 'dsh-cleanup-mode-card' },
          h('span', { className: 'dsh-cleanup-radio', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-cleanup-mode-text' },
            h('span', { className: 'dsh-cleanup-mode-label' }, options.label),
            options.note ? h('span', { className: 'dsh-cleanup-mode-note' }, options.note) : null,
          ),
        ),
      )
    }

    function renderReviewBody(context) {
      const t = context.t
      const state = context.state
      const catalog = context.catalog
      const plan = state.plan && typeof state.plan === 'object' ? state.plan : null
      const disabled = state.phase === 'deleting' || state.phase === 'deferring' || state.refreshing === true
      const items = (plan && Array.isArray(plan.items) ? plan.items : []).filter(function (item) { return item && typeof item === 'object' })
      const warnings = plan && Array.isArray(plan.warnings) ? plan.warnings : []
      const blockers = plan && Array.isArray(plan.blockers) ? plan.blockers : []
      const deferrability = planDeferrability(plan)
      const totals = plan && plan.totals && typeof plan.totals === 'object' ? plan.totals : {}
      const confirmation = plan && isTypedConfirmation(plan.confirmation) ? plan.confirmation : null
      // The planned targets are the checked subset; `state.targets` still lists every reviewed row so
      // un-checking a row (even the last one) can be undone (SPEC §9).
      const planned = plan === null
        ? []
        : (Array.isArray(plan.targets) && plan.targets.length > 0 ? plan.targets : state.targets)
      let workspaceTargetCount = 0
      for (let i = 0; i < planned.length; i += 1) {
        if (planned[i].kind === 'workspace') workspaceTargetCount += 1
      }
      const hasWorkspaceTarget = workspaceTargetCount > 0
      const hasSessionTarget = planned.some(function (target) { return target.kind === 'session' })
      const selection = Object.create(null)
      for (let i = 0; i < state.selection.length; i += 1) selection[state.selection[i]] = true
      const grouped = groupPlanItems(items, state.targets)
      // Every reviewed row is checkable — a single target too, because un-checking it is how the user
      // backs out before confirming. A workspace clear narrows its current batch the same way and
      // remembers the exclusions for the batches that follow.
      const selectable = state.targets.length > 0
      let checkedRows = 0
      for (let i = 0; i < state.targets.length; i += 1) {
        if (selection[targetKey(state.targets[i])] === true) checkedRows += 1
      }
      // SPEC §4.3/§9: one typed folder name must never authorize several folders.
      // The Host refuses such a plan outright; the UI disables the option first.
      const permanentMultipleDirectories = workspaceTargetCount > 1
      const permanentAllowed = plan === null || plan.allowPermanentDeletion !== false
      const permanentBlocked = permanentMultipleDirectories || !permanentAllowed
      const permanentNote = permanentMultipleDirectories
        ? t('dialog.mode.permMulti')
        : (!permanentAllowed ? t('dialog.mode.permDisabled') : null)
      const typed = state.typed
      const mismatch = confirmation !== null && typed.length > 0 && typed.trim() !== String(confirmation.expected)

      const children = []

      children.push(h('div', { className: 'dsh-cleanup-section', key: 'targets' },
        h('div', { className: 'dsh-cleanup-section-title' },
          h('span', null, t('dialog.section.targets')),
          selectable && state.targets.length > 0
            ? h('span', { className: 'dsh-cleanup-select-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-cleanup-inline-action',
                disabled: disabled || checkedRows === state.targets.length,
                onClick: context.onSelectAll,
              }, t('dialog.select.all')),
              h('button', {
                type: 'button',
                className: 'dsh-cleanup-inline-action',
                disabled: disabled,
                onClick: context.onInvert,
              }, t('dialog.select.invert')),
            )
            : null,
        ),
        selectable && state.targets.length > 1
          ? h('div', { className: 'dsh-cleanup-muted' }, plural(t, 'dialog.select.count', checkedRows, { total: formatNumber(state.targets.length) }))
          : null,
        selectable && checkedRows === 0
          ? h('div', { className: 'dsh-cleanup-select-required', role: 'alert' }, t('dialog.select.required'))
          : null,
        h('div', { className: 'dsh-cleanup-target-list' }, grouped.groups.map(function (group) {
          const groupKey = targetKey(group.target)
          const isWorkspace = group.target.kind === 'workspace'
          // Swept folder Sessions follow `includeSessions`; subagent logs follow
          // `includeDescendants`. Both are collapsed under the row they belong to.
          const rideAlong = isWorkspace
            ? (state.includeSessions === true ? group.swept : [])
            : (state.includeDescendants === true ? group.children : [])
          return h('div', { className: 'dsh-cleanup-target-block', key: 'block:' + groupKey },
            renderTargetRow({
              t: t,
              catalog: catalog,
              group: group,
              selectable: selectable,
              checked: selectable ? selection[groupKey] === true : true,
              // A row can be checked while the plan in flight still lacks its item: show a pending
              // state instead of the "not selected" copy that would contradict the checkbox.
              pending: state.refreshing === true && selection[groupKey] === true && group.main === null,
              disabled: disabled,
              onToggle: context.onToggleSelection,
            }),
            renderTargetChildren({
              t: t,
              catalog: catalog,
              items: rideAlong,
              listId: 'dsh-cleanup-target-kids-' + domIdSafe(groupKey),
              summaryKey: isWorkspace ? 'dialog.groups.swept' : 'dialog.groups.descendants',
              expanded: context.expandedGroups[groupKey] === true,
              disabled: disabled,
              onToggleExpanded: function () { context.onToggleGroup(groupKey) },
            }),
          )
        })),
        grouped.leftovers.length > 0
          ? h('div', { className: 'dsh-cleanup-list' }, grouped.leftovers.map(function (item) { return renderPlanItem(t, item, catalog) }))
          : null,
        hasSessionTarget && state.clear === null
          ? h('label', { className: 'dsh-cleanup-checkrow', key: 'include-descendants' },
            h('input', {
              type: 'checkbox',
              className: 'dsh-cleanup-check',
              checked: state.includeDescendants === true,
              disabled: disabled,
              onChange: function (event) { context.onIncludeDescendants(event.target.checked) },
            }),
            h('span', null, t('dialog.includeDescendants')),
          )
          : null,
        state.descendantsAutoOff === true && state.clear === null
          ? h('div', { className: 'dsh-cleanup-muted', key: 'descendants-auto-off' }, t('dialog.descendants.autoOff'))
          : null,
        state.refreshing === true
          ? h('div', { className: 'dsh-cleanup-muted', key: 'totals-refreshing' }, t('dialog.totalsRefreshing'))
          : (plan === null
            ? null
            : h('div', { className: 'dsh-cleanup-totals' }, t('dialog.totals', {
              size: formatBytes(typeof totals.bytes === 'number' ? totals.bytes : 0),
              files: plural(t, 'count.file', totals.files),
              dirs: plural(t, 'count.dir', totals.dirs),
            }))),
        plan !== null && typeof plan.expiresAt === 'number'
          ? h('div', { className: 'dsh-cleanup-muted' }, t('dialog.expires', { time: formatTime(plan.expiresAt) || t('common.none') }))
          : null,
      ))

      if (warnings.length > 0) {
        children.push(h('div', { className: 'dsh-cleanup-section', key: 'warnings' },
          h('div', { className: 'dsh-cleanup-section-title' }, t('dialog.section.warnings')),
          h('ul', { className: 'dsh-cleanup-notices' }, warnings.map(function (warning, index) {
            return h('li', { key: 'warning-' + index, className: 'dsh-cleanup-notice dsh-cleanup-notice-warn' },
              h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, '!'),
              h('span', null, warningText(t, warning)),
            )
          })),
        ))
      }

      if (blockers.length > 0) {
        children.push(h('div', { className: 'dsh-cleanup-section', key: 'blockers' },
          h('div', { className: 'dsh-cleanup-section-title dsh-cleanup-section-title-error' }, t('dialog.section.blockers')),
          h('ul', { className: 'dsh-cleanup-notices' }, blockers.map(function (blocker, index) {
            const code = blocker && typeof blocker.code === 'string' ? blocker.code : ''
            // task-9: for a queueable plan, describe the cause instead of the old
            // "restart and retry" dead end. The generic `error.SESSION_*` copies stay
            // as the fallback for every other context (e.g. a failed delete).
            const text = deferrability.canDefer && code === 'SESSION_LIVE'
              ? t('dialog.blocker.sessionHeld.liveItem')
              : (deferrability.canDefer && code === 'SESSION_RUNNING'
                ? t('dialog.blocker.sessionHeld.runningItem')
                : (deferrability.canDefer && code === 'WORKSPACE_HAS_LIVE_SESSIONS'
                  ? t('dialog.blocker.sessionHeld.workspaceItem')
                  : localizedCode(t, 'error', code, blocker && blocker.message)))
            return h('li', { key: 'blocker-' + index, className: 'dsh-cleanup-notice dsh-cleanup-notice-error', role: 'alert' },
              h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, '×'),
              h('span', null, text),
            )
          })),
          deferrability.canDefer
            ? h('div', { className: 'dsh-cleanup-defer-hint', key: 'session-held' },
              h('div', { className: 'dsh-cleanup-defer-hint-title' }, t('dialog.blocker.sessionHeld.title')),
              h('div', { className: 'dsh-cleanup-muted' }, t('dialog.blocker.sessionHeld.body', {
                schedule: t('dialog.defer.actionShort'),
                cancel: t('action.cancel'),
              })),
            )
            : (deferrability.sessionHeld > 0
              ? h('div', { className: 'dsh-cleanup-muted', key: 'defer-unavailable' }, t('dialog.defer.unavailable'))
              : null),
          // F7: the generic "fix the issues and retry" hint contradicts the offered
          // deferred route, so it is only rendered when deferring is not available.
          deferrability.canDefer ? null : h('div', { className: 'dsh-cleanup-muted' }, t('dialog.blocker.hint')),
        ))
      }

      children.push(h('div', { className: 'dsh-cleanup-section', key: 'mode' },
        h('div', { className: 'dsh-cleanup-section-title', id: context.modeLabelId }, t('dialog.mode.label')),
        h('div', { className: 'dsh-cleanup-modes', role: 'radiogroup', 'aria-labelledby': context.modeLabelId },
          renderModeOption(t, {
            mode: 'trash',
            label: t('dialog.mode.trash'),
            active: state.mode === 'trash',
            blocked: false,
            disabled: disabled,
            groupName: context.modeGroupName,
            onChange: context.onMode,
          }),
          renderModeOption(t, {
            mode: 'permanent',
            label: t('dialog.mode.perm'),
            active: state.mode === 'permanent',
            blocked: permanentBlocked,
            note: permanentNote,
            disabled: disabled,
            groupName: context.modeGroupName,
            onChange: context.onMode,
          }),
        ),
        h('div', { className: 'dsh-cleanup-muted' }, t(state.mode === 'permanent' ? 'dialog.mode.permHint' : 'dialog.mode.trashHint')),
        state.modeNotice === true
          ? h('div', { className: 'dsh-cleanup-notice', key: 'mode-notice' },
            h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, 'i'),
            h('span', null, t('dialog.mode.permAutoTrash')),
          )
          : null,
      ))

      if (hasWorkspaceTarget) {
        children.push(h('label', { className: 'dsh-cleanup-checkrow', key: 'include-sessions' },
          h('input', {
            type: 'checkbox',
            className: 'dsh-cleanup-check',
            checked: state.includeSessions === true,
            disabled: disabled,
            onChange: function (event) { context.onIncludeSessions(event.target.checked) },
          }),
          h('span', null, t('dialog.includeSessions')),
        ))
      }

      if (confirmation !== null) {
        children.push(h('label', { className: 'dsh-cleanup-field', key: 'confirmation' },
          h('span', { className: 'dsh-cleanup-field-label' }, t('dialog.confirm.label', { name: String(confirmation.expected) })),
          h('input', {
            className: 'dsh-cleanup-input',
            type: 'text',
            value: typed,
            disabled: disabled,
            placeholder: t('dialog.confirm.placeholder'),
            autoComplete: 'off',
            spellCheck: false,
            'aria-invalid': mismatch ? 'true' : undefined,
            onChange: function (event) { context.onTyped(event.target.value) },
          }),
          mismatch ? h('span', { className: 'dsh-cleanup-field-error', role: 'alert' }, t('dialog.confirm.mismatch')) : null,
        ))
      }

      return children
    }

    /** Max distinct trash locations listed on the done page. */
    const DONE_TRASHED_PATHS_MAX = 4

    /**
     * Review-time explanation for a workspace clear (SPEC §7 item 5): how many Session logs the
     * workspace holds, that this review covers the first batch, and what is kept.
     */
    function renderClearReviewNote(t, state) {
      const clear = state.clear && typeof state.clear === 'object' ? state.clear : {}
      const title = typeof clear.title === 'string' ? clear.title : ''
      const deletable = typeof clear.deletable === 'number' ? clear.deletable : 0
      // The Host's `total` counts every match before the page limit, so it is what "the workspace
      // holds"; `deletable` only describes the first page and is a lower bound.
      const total = typeof clear.total === 'number' && clear.total > 0 ? clear.total : deletable
      const skipped = typeof clear.skipped === 'number' ? clear.skipped : 0
      const excluded = clear.excluded && typeof clear.excluded === 'object' ? Object.keys(clear.excluded).length : 0
      // The batch this review covers is the checked subset, not every row the batch could hold.
      const batch = Array.isArray(state.selection) ? state.selection.length : 0
      const children = [
        h('div', { className: 'dsh-cleanup-notice', key: 'lead' },
          h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, 'i'),
          h('span', null, batch === 0
            ? plural(t, 'dialog.clear.reviewEmpty', total, { title: title })
            : plural(t, 'dialog.clear.review', total, { title: title, batch: formatNumber(batch) })),
        ),
        h('div', { className: 'dsh-cleanup-muted', key: 'scope' }, t('dialog.clear.scope')),
      ]
      if (skipped > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'skipped' }, plural(t, 'dialog.clear.skipped', skipped)))
      }
      if (excluded > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'excluded' }, plural(t, 'dialog.clear.excluded', excluded)))
      }
      // The batch is counted in root Sessions, but one plan item can expand into subagent logs; say
      // what the review really covers instead of implying the two numbers are the same.
      const plan = state.plan && typeof state.plan === 'object' ? state.plan : null
      const planItems = plan && Array.isArray(plan.items) ? plan.items.length : 0
      const plannedRoots = plan && Array.isArray(plan.targets) ? plan.targets.length : 0
      if (planItems > plannedRoots && planItems > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'logs' }, plural(t, 'dialog.clear.reviewLogs', planItems)))
      }
      return h('div', {
        className: 'dsh-cleanup-clear-note',
        key: 'clear-note',
        style: { display: 'flex', flexDirection: 'column', gap: '6px' },
      }, children)
    }

    /** Result body for a workspace clear: the folded batch totals and why the walk stopped. */
    function renderClearDoneBody(t, state, describedById) {
      const clear = state.clear && typeof state.clear === 'object' ? state.clear : {}
      const done = clear.done && typeof clear.done === 'object' ? clear.done : {}
      const count = typeof done.count === 'number' ? done.count : 0
      const bytes = typeof done.bytes === 'number' ? done.bytes : 0
      const failed = typeof done.failed === 'number' ? done.failed : 0
      const skipped = typeof clear.skipped === 'number' ? clear.skipped : 0
      const excluded = clear.excluded && typeof clear.excluded === 'object' ? Object.keys(clear.excluded).length : 0
      const stop = clear.stop && typeof clear.stop === 'object' ? clear.stop : null
      const remaining = stop && typeof stop.remaining === 'number' ? stop.remaining : 0
      const total = typeof clear.total === 'number' ? clear.total : 0
      const mode = state.mode === 'permanent' ? 'permanent' : 'trash'
      const children = []
      if (stop !== null && stop.code === 'empty') {
        // The pre-flight found nothing it could clear: explain it here rather than in a toast.
        children.push(h('div', { className: 'dsh-cleanup-done-title', key: 'title' }, t('dialog.clear.emptyTitle')))
        children.push(h('div', { key: 'summary' }, skipped > 0 && total > 0
          ? plural(t, 'dialog.clear.emptyInUse', skipped)
          : t('dialog.clear.emptyNone')))
        if (excluded > 0) {
          children.push(h('div', { className: 'dsh-cleanup-muted', key: 'excluded' }, plural(t, 'dialog.clear.excluded', excluded)))
        }
        return h('div', {
          className: 'dsh-cleanup-done',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'true',
          id: describedById,
        }, children)
      }
      if (count === 0 && failed > 0) {
        children.push(h('div', { className: 'dsh-cleanup-failed-title', key: 'title' }, t('dialog.failed.deleteTitle')))
        children.push(h('div', { key: 'summary' }, plural(t, 'dialog.done.allFailedSummary', failed)))
      } else {
        children.push(h('div', { className: 'dsh-cleanup-done-title', key: 'title' }, t('dialog.clear.title')))
        children.push(h('div', { key: 'summary' }, plural(t, 'dialog.clear.done_summary', count, { size: formatBytes(bytes) })))
      }
      if (skipped > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'skipped' }, plural(t, 'dialog.clear.skipped', skipped)))
      }
      if (excluded > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'excluded' }, plural(t, 'dialog.clear.excluded', excluded)))
      }
      if (failed > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'failed' }, plural(t, 'dialog.done.partial', failed)))
      }
      if (stop !== null) {
        const text = stop.code === 'limit'
          ? t('dialog.clear.stop.limit')
          : plural(t, stop.code === 'failed' ? 'dialog.clear.stop.failed' : 'dialog.clear.stop.blocked', remaining)
        children.push(h('div', { className: 'dsh-cleanup-notice dsh-cleanup-notice-warn', key: 'stop' },
          h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, '!'),
          h('span', null, text),
        ))
      }
      children.push(h('div', { className: 'dsh-cleanup-muted', key: 'mode' },
        mode === 'trash' ? t('dialog.clear.trashNote') : t('dialog.clear.permNote')))
      return h('div', {
        className: 'dsh-cleanup-done',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        id: describedById,
      }, children)
    }

    /**
     * Done view for a delete request.
     *
     * A result where nothing was deleted is a failure (own heading, red
     * title, failed count as the primary fact), never a green "complete".
     * The result is a polite atomic live region, and it is associated with
     * the dialog through `aria-describedby` (the caller passes its id).
     * Every distinct `movedTo` is reported (bounded), not only the first.
     */
    function renderDoneBody(t, state, describedById) {
      if (state.clear !== null && state.clear !== undefined) return renderClearDoneBody(t, state, describedById)
      const result = state.result
      const totals = result && result.totals && typeof result.totals === 'object' ? result.totals : {}
      const trashed = typeof totals.trashed === 'number' ? totals.trashed : 0
      const deleted = typeof totals.deleted === 'number' ? totals.deleted : 0
      const failed = typeof totals.failed === 'number' ? totals.failed : 0
      const bytes = typeof totals.bytes === 'number' ? totals.bytes : 0
      const succeeded = trashed + deleted
      const allFailed = succeeded === 0 && failed > 0
      const items = result && Array.isArray(result.items) ? result.items : []

      const trashedPaths = []
      const seenPaths = {}
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]
        if (!item || item.status !== 'trashed' || typeof item.movedTo !== 'string' || item.movedTo === '') continue
        if (seenPaths[item.movedTo] === true) continue
        seenPaths[item.movedTo] = true
        trashedPaths.push(item.movedTo)
      }
      const shownPaths = trashedPaths.slice(0, DONE_TRASHED_PATHS_MAX)
      const hiddenPaths = trashedPaths.length - shownPaths.length

      const children = []
      if (allFailed) {
        children.push(h('div', { className: 'dsh-cleanup-failed-title', key: 'title' }, t('dialog.failed.deleteTitle')))
        children.push(h('div', { key: 'summary' }, plural(t, 'dialog.done.allFailedSummary', failed)))
      } else {
        children.push(h('div', { className: 'dsh-cleanup-done-title', key: 'title' }, t('dialog.done.title')))
        children.push(h('div', { key: 'summary' }, plural(t, 'dialog.done.summary', succeeded, { size: formatBytes(bytes) })))
      }
      if (trashedPaths.length === 1) {
        children.push(h('div', { className: 'dsh-cleanup-muted dsh-cleanup-mono', key: 'trashed', title: trashedPaths[0] },
          t('dialog.done.trashed', { path: trashedPaths[0] }),
        ))
      } else if (trashedPaths.length > 1) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'trashed-many' },
          t('dialog.done.trashedMany', { count: formatNumber(trashedPaths.length) }),
        ))
        children.push(h('ul', { className: 'dsh-cleanup-done-paths', key: 'trashed-paths' },
          shownPaths.map(function (path, index) {
            return h('li', {
              className: 'dsh-cleanup-done-path dsh-cleanup-muted dsh-cleanup-mono',
              key: 'trashed-path-' + index,
              title: path,
            }, middleEllipsis(path, 96))
          }),
        ))
        if (hiddenPaths > 0) {
          children.push(h('div', { className: 'dsh-cleanup-muted', key: 'trashed-more' }, plural(t, 'dialog.done.trashedMore', hiddenPaths)))
        }
      }
      if (trashedPaths.length > 0) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'note' }, t('dialog.done.note')))
      }
      if (failed > 0 && allFailed === false) {
        children.push(h('div', { className: 'dsh-cleanup-notice dsh-cleanup-notice-warn', key: 'partial' },
          h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, '!'),
          h('span', null, plural(t, 'dialog.done.partial', failed)),
        ))
      }
      return h('div', {
        className: 'dsh-cleanup-done',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        id: describedById,
      }, children)
    }

    /**
     * Distinct done-style state for a queued deletion (task-9): the deletion did
     * not happen now, it is scheduled for the next DSH start. Announced politely
     * and associated with the dialog through `aria-describedby`.
     */
    function renderDeferredBody(t, state, describedById) {
      const deferred = state.deferred && typeof state.deferred === 'object' ? state.deferred : {}
      const targets = Array.isArray(state.targets) ? state.targets : []
      const plan = state.plan && typeof state.plan === 'object' ? state.plan : {}
      const planItems = Array.isArray(plan && plan.items) ? plan.items : []
      // F2: `deferred.count` is the number of queued ENTRIES. This result must report
      // what this reviewed plan will delete (its plan items), and state the Host
      // queue size separately.
      const planItemCount = planItems.length > 0 ? planItems.length : Math.max(1, targets.length)
      // `clear.total` counts root Sessions; the plan's items may also include subagent logs, so the
      // remaining count must be measured against the reviewed root targets, not the item count.
      const plannedRoots = Array.isArray(plan.targets) && plan.targets.length > 0 ? plan.targets.length : Math.max(1, targets.length)
      const queueCount = typeof deferred.count === 'number' && isFinite(deferred.count) && deferred.count > 0
        ? Math.floor(deferred.count)
        : 1
      const mode = deferred.mode === 'permanent' || state.mode === 'permanent' ? 'permanent' : 'trash'
      const children = [
        h('div', { className: 'dsh-cleanup-done-title', key: 'title' }, t('dialog.deferred.title')),
        h('div', { key: 'summary' }, plural(t, 'dialog.deferred.summary', planItemCount)),
        h('div', { className: 'dsh-cleanup-muted', key: 'queue' }, plural(t, 'dialog.deferred.queue', queueCount)),
        h('div', { className: 'dsh-cleanup-muted', key: 'mode' }, t('dialog.deferred.mode', { mode: deferredModeText(t, mode) })),
      ]
      if (deferred.replaced === true) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'replaced' }, t('dialog.deferred.replaced')))
      }
      // A clear that could only queue part of the workspace says so, so nobody thinks the rest went too.
      const clear = state.clear && typeof state.clear === 'object' ? state.clear : null
      if (clear !== null && typeof clear.total === 'number' && clear.total > plannedRoots) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'clear-more' },
          plural(t, 'dialog.clear.deferredMore', clear.total - plannedRoots)))
      }
      children.push(h('div', { className: 'dsh-cleanup-muted', key: 'note' }, t('dialog.deferred.note')))
      return h('div', {
        className: 'dsh-cleanup-done',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        id: describedById,
      }, children)
    }

    function renderFailedBody(t, state) {
      const stage = state.failureStage === 'delete' || state.failureStage === 'defer' ? state.failureStage : 'plan'
      const titleKey = state.clear !== null && stage === 'plan'
        ? 'dialog.clear.failedTitle'
        : (stage === 'delete'
          ? 'dialog.failed.deleteTitle'
          : (stage === 'defer' ? 'dialog.failed.deferTitle' : 'dialog.failed.planTitle'))
      const error = state.error
      const code = apiErrorCode(error)
      const clearDone = state.clear && state.clear.done && typeof state.clear.done === 'object' ? state.clear.done : null
      const partial = clearDone && typeof clearDone.count === 'number' && clearDone.count > 0
        ? h('div', { className: 'dsh-cleanup-muted' },
          plural(t, 'dialog.clear.done_summary', clearDone.count, { size: formatBytes(typeof clearDone.bytes === 'number' ? clearDone.bytes : 0) }))
        : null
      return h('div', { className: 'dsh-cleanup-failed', role: 'alert' },
        h('div', { className: 'dsh-cleanup-failed-title' }, t(titleKey)),
        h('div', { className: 'dsh-cleanup-notice dsh-cleanup-notice-error' },
          h('span', { className: 'dsh-cleanup-notice-mark', 'aria-hidden': 'true' }, '×'),
          h('span', null, apiErrorText(t, error)),
        ),
        partial,
        code !== null
          ? h('div', { className: 'dsh-cleanup-muted dsh-cleanup-mono' }, t('dialog.failed.code', { code: code }))
          : null,
      )
    }

    /** Targets the current review actually covers: the planned subset once a plan exists. */
    function dialogTargetList(state) {
      const plan = state.plan
      if (plan && Array.isArray(plan.targets) && plan.targets.length > 0) return plan.targets
      return Array.isArray(state.targets) ? state.targets : []
    }

    function dialogTitleText(t, targets, state) {
      if (state && state.clear) return t('dialog.title.workspaceSessions')
      let workspace = false
      let session = false
      for (let i = 0; i < targets.length; i += 1) {
        if (targets[i].kind === 'workspace') workspace = true
        else session = true
      }
      if (workspace && session) return t('dialog.title.mixed')
      return workspace ? t('dialog.title.workspace') : t('dialog.title.session')
    }

    function dialogSubText(t, targets, state, catalog) {
      if (state && state.clear) {
        const title = typeof state.clear.title === 'string' && state.clear.title !== '' ? state.clear.title : ''
        return title !== '' ? title : shortId(state.clear.workspaceId)
      }
      if (targets.length !== 1) return plural(t, 'dialog.targets.count', targets.length)
      const target = targets[0]
      const plan = state.plan
      let planItem = null
      if (plan && Array.isArray(plan.items)) {
        for (let i = 0; i < plan.items.length; i += 1) {
          const candidate = plan.items[i]
          if (!candidate || typeof candidate !== 'object') continue
          const expectedKind = target.kind === 'workspace' ? 'workspace-dir' : 'session'
          if (candidate.kind === expectedKind && candidate.id === target.id) { planItem = candidate; break }
        }
      }
      if (target.kind === 'workspace') {
        if (typeof target.path === 'string' && target.path !== '') return target.path
        if (planItem && typeof planItem.path === 'string' && planItem.path !== '') return planItem.path
        if (typeof target.title === 'string' && target.title !== '') return target.title
        return shortId(target.id)
      }
      // Session: the captured menu title wins (same value the sidebar shows), then
      // the live session catalog, then the cwd basename, then the short id.
      if (typeof target.title === 'string' && target.title !== '') return target.title
      const fromCatalog = catalogDisplayTitle(catalog, target.id)
      if (fromCatalog !== null) return fromCatalog
      const entry = catalogEntry(catalog, target.id)
      const cwd = typeof target.cwd === 'string' && target.cwd !== ''
        ? target.cwd
        : (entry && typeof entry.cwd === 'string' ? entry.cwd : '')
      const cwdBase = baseName(cwd)
      if (cwdBase !== '') return cwdBase
      return shortId(target.id)
    }

    // ------------------------------------------------------------------ dialog

    /**
     * Single review dialog. State lives in the module-level store owned by
     * `apply`, so the overlay entry can mount/unmount without losing an open
     * review; data and timers are owned by `apply` and disposed with the plugin
     * (and by this component on unmount, per SPEC §7).
     */
    function CleanupDialog(props) {
      const api = props.api
      const t = props.t || (api && api.t)
      // `settings` is the copy rendered inside the storage-cleanup settings page; it presents
      // only a review opened from that page. `overlay` is the shell.overlay entry, which serves
      // the context-menu actions. Each copy stands down for the other's dialog.
      const surface = props.surface === 'settings' ? 'settings' : 'overlay'
      const store = (api && api.dialogStore) || FALLBACK_DIALOG_STORE
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const catalogApi = (api && api.catalog) || FALLBACK_CATALOG
      const catalog = useSyncExternalStore(catalogApi.subscribe, catalogApi.getSnapshot)
      const titleId = useId()
      const modeLabelId = useId()
      const describedById = useId()
      const modeGroupName = 'dsh-cleanup-mode-' + String(titleId).replace(/[^a-zA-Z0-9_-]/g, '')
      const panelRef = useRef(null)
      const cancelRef = useRef(null)
      const closeRef = useRef(null)
      const retryRef = useRef(null)
      const doneRef = useRef(null)
      const backdropDownRef = useRef(false)
      const lastPhaseRef = useRef('idle')

      const phase = state.phase
      const busy = phase === 'deleting' || phase === 'deferring'
      // Both copies subscribe to one dialog store; only the copy that owns the current surface
      // may take the scroll lock, or the two would interleave their save/restore of
      // <html>.style.overflow and leave the page locked after the dialog closes.
      const modalVisible = state.surface === surface && phase !== 'idle'

      // SPEC §10 / P3 #14: report elapsed time while a delete is in flight. The timer
      // only runs during `deleting`, starts from the store's stamp, and is cleared when
      // the phase settles (success, failure, dismiss or unmount).
      const [deleteElapsedSeconds, setDeleteElapsedSeconds] = useState(0)
      // Which reviewed rows have their ride-along list (subagent logs / swept folder Sessions) open.
      // Presentation-only state, keyed by `kind:id`, so it survives a re-plan.
      const [expandedGroups, setExpandedGroups] = useState({})

      function toggleGroup(key) {
        setExpandedGroups(function (previous) {
          const next = Object.assign({}, previous)
          if (next[key] === true) delete next[key]
          else next[key] = true
          return next
        })
      }

      useEffect(function () {
        if (phase !== 'deleting') return undefined
        setDeleteElapsedSeconds(0)
        const timer = setInterval(function () {
          setDeleteElapsedSeconds(function (value) { return value + 1 })
        }, 1000)
        return function () { clearInterval(timer) }
      }, [phase, state.deletingStartedAt])

      useEffect(function () {
        if (!api) return undefined
        return function () {
          // A sheet-hosted dialog unmounts with its sheet: closing the settings panel must
          // drop the review and hand focus back, but it must not tear down a dialog the
          // overlay copy is still presenting.
          if (surface === 'settings') {
            // Only a sheet-hosted review dies with the sheet; an overlay review opened while the sheet
            // happened to be open belongs to the other copy and must survive it.
            const snapshot = api.dialogStore.getSnapshot()
            if (snapshot.surface !== 'settings') return
            // A delete already on the wire is not cancelled by closing the sheet: its result would be
            // lost while the Host keeps executing. Keep the state (and its summary) so re-opening the
            // page shows it; a clean result must not be dropped by the dwell timer in the meantime.
            if (snapshot.phase === 'deleting' || snapshot.phase === 'deferring') {
              api.dialogStore.setState({ keepSummary: true })
              return
            }
            api.closeDialog()
            return
          }
          api.disposeDialog()
        }
      }, [api, surface])

      // Focus moves only when the dialog ENTERS a phase. A re-plan keeps the
      // phase ('review') and only re-renders `state.plan` / `state.refreshing`, so
      // it must never steal focus from the control the user is operating.
      useEffect(function () {
        const entered = lastPhaseRef.current !== phase
        lastPhaseRef.current = phase
        if (!entered || phase === 'idle') return
        let target
        if (phase === 'planning' || phase === 'deleting' || phase === 'deferring') target = panelRef.current
        else if (phase === 'review') target = cancelRef.current
        else if (phase === 'failed') target = retryRef.current || closeRef.current || panelRef.current
        else if (phase === 'done') target = doneRef.current || panelRef.current
        else if (phase === 'deferred') target = closeRef.current || panelRef.current
        if (target && typeof target.focus === 'function') {
          try { target.focus({ preventScroll: true }) } catch (error) { /* focus is best effort */ }
        }
      }, [phase])

      // Lock background scrolling while the modal is mounted, and restore
      // whatever the host had set when it unmounts.
      useEffect(function () {
        if (!modalVisible || typeof document === 'undefined' || !document.documentElement) return undefined
        const root = document.documentElement
        const body = document.body
        const previousRootOverflow = root.style.overflow
        const previousBodyOverflow = body ? body.style.overflow : ''
        const previousPaddingRight = root.style.paddingRight
        let scrollbar = 0
        try {
          if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') {
            scrollbar = Math.max(0, window.innerWidth - root.clientWidth)
          }
        } catch (error) { scrollbar = 0 }
        root.style.overflow = 'hidden'
        if (body) body.style.overflow = 'hidden'
        if (scrollbar > 0) root.style.paddingRight = scrollbar + 'px'
        return function () {
          root.style.overflow = previousRootOverflow
          if (body) body.style.overflow = previousBodyOverflow
          if (scrollbar > 0) root.style.paddingRight = previousPaddingRight
        }
      }, [modalVisible])

      // Keyboard contract (SPEC §9): Escape dismisses in review/failed (and while
      // planning), never while deleting; Tab keeps focus inside the dialog. The
      // listener is document-level so it still works if focus fell to <body>.
      useEffect(function () {
        if (typeof document === 'undefined' || !api) return undefined
        if (phase === 'idle') return undefined
        function handleKeyDown(event) {
          if (event.defaultPrevented) return
          if (event.key === 'Escape') {
            // Never dismiss mid-delete. The propagation stops also matter for a dialog hosted inside
            // the settings sheet: its own document-level Escape listener must not close the panel
            // underneath the review. stopPropagation alone cannot silence a listener already
            // registered on the same node, so stopImmediatePropagation covers those when available
            // (a listener registered earlier still runs first — that is the host's call, not ours).
            event.preventDefault()
            event.stopPropagation()
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
            if (busy) return
            api.dismissDialog()
            return
          }
          if (event.key === 'Tab') trapFocus(event, panelRef.current)
        }
        document.addEventListener('keydown', handleKeyDown, true)
        return function () { document.removeEventListener('keydown', handleKeyDown, true) }
      }, [api, phase, busy])

      if (!api) return null
      if (phase === 'idle') return null
      if (state.surface !== surface) return null

      const plan = state.plan
      const blockers = plan && Array.isArray(plan.blockers) ? plan.blockers : []
      const deletingItemCount = plan && Array.isArray(plan.items) ? plan.items.length : 0
      const confirmation = plan && isTypedConfirmation(plan.confirmation) ? plan.confirmation : null
      const typedMatches = confirmation === null || state.typed.trim() === String(confirmation.expected)
      const deleteDisabled = phase !== 'review' || state.refreshing === true || plan === null || blockers.length > 0 || typedMatches === false
      const deferrability = planDeferrability(plan)
      // A workspace clear normally plans one batch that is immediately deletable, so queueing is
      // withheld; when nothing can run now (every row waits for a restart) the queue is the only
      // useful action and is offered instead.
      const canDefer = deferrability.canDefer && (state.clear === null || state.clear.deletable === 0)
      const deferDisabled = phase !== 'review' || state.refreshing === true || typedMatches === false
      const canDismiss = busy === false

      let footer
      if (phase === 'planning' || (phase === 'review' && state.refreshing === true)) {
        footer = [
          h('button', {
            key: 'cancel',
            ref: cancelRef,
            type: 'button',
            className: 'dsh-cleanup-btn',
            onClick: api.dismissDialog,
          }, t('action.cancel')),
        ]
      } else if (phase === 'review') {
        footer = [
          h('button', {
            key: 'cancel',
            ref: cancelRef,
            type: 'button',
            className: 'dsh-cleanup-btn',
            onClick: api.dismissDialog,
          }, t('action.cancel')),
          canDefer
            ? h('button', {
              key: 'defer',
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-accent',
              disabled: deferDisabled,
              onClick: api.deferPlan,
            }, t('dialog.defer.action'))
            : null,
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-danger',
            disabled: deleteDisabled,
            onClick: api.confirmDelete,
          }, t(state.clear !== null ? 'dialog.footer.clear' : 'dialog.footer.delete')),
        ]
      } else if (phase === 'deleting') {
        footer = [
          h('div', { key: 'progress', className: 'dsh-cleanup-progress', role: 'status' },
            h(Spinner, null),
            h('span', null, t('dialog.deleting')),
            // Only the plan's own item count is reported: the Host does not stream
            // per-item progress, so a fake "i of N" counter would be a lie.
            deletingItemCount > 1
              ? h('span', { className: 'dsh-cleanup-progress-items' }, plural(t, 'dialog.deleting.items', deletingItemCount))
              : null,
            // A workspace clear walks the workspace in batches; the batch number and the folded
            // count are the only honest progress facts (the Host does not stream per-item events).
            state.clear !== null
              ? h('span', { className: 'dsh-cleanup-progress-items' },
                plural(t, 'dialog.clear.progress', state.clear.batches + 1, {
                  batch: formatNumber(state.clear.batches + 1),
                  done: formatNumber(state.clear.done.count),
                }))
              : null,
            h('span', {
              className: 'dsh-cleanup-progress-elapsed',
              'aria-hidden': 'true',
            }, plural(t, 'dialog.deleting.elapsed', deleteElapsedSeconds, {
              seconds: formatNumber(deleteElapsedSeconds),
            })),
          ),
          h('button', { key: 'cancel', type: 'button', className: 'dsh-cleanup-btn', disabled: true }, t('action.cancel')),
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-danger',
            disabled: true,
          }, plural(t, 'dialog.deleting.button', deleteElapsedSeconds, {
            seconds: formatNumber(deleteElapsedSeconds),
          })),
        ]
      } else if (phase === 'deferring') {
        footer = [
          h('div', { key: 'progress', className: 'dsh-cleanup-progress', role: 'status' },
            h(Spinner, null),
            h('span', null, t('dialog.deferring')),
          ),
          h('button', { key: 'cancel', type: 'button', className: 'dsh-cleanup-btn', disabled: true }, t('action.cancel')),
          h('button', { key: 'defer', type: 'button', className: 'dsh-cleanup-btn dsh-cleanup-btn-accent', disabled: true }, t('dialog.defer.action')),
        ]
      } else if (phase === 'done') {
        footer = [
          h('button', {
            key: 'done',
            ref: doneRef,
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-accent',
            onClick: api.closeDialog,
          }, t('action.done')),
        ]
      } else if (phase === 'deferred') {
        footer = [
          h('button', {
            key: 'close',
            ref: closeRef,
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-accent',
            onClick: api.closeDialog,
          }, t('action.close')),
        ]
      } else {
        footer = [
          h('button', {
            key: 'close',
            ref: closeRef,
            type: 'button',
            className: 'dsh-cleanup-btn',
            onClick: api.closeDialog,
          }, t('action.close')),
          h('button', {
            key: 'retry',
            ref: retryRef,
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-accent',
            onClick: api.retryDialog,
          }, t('action.retry')),
        ]
      }

      const bodyChildren = []
      if (phase === 'planning') {
        bodyChildren.push(h('div', { className: 'dsh-cleanup-progress', key: 'planning', role: 'status' },
          h(Spinner, null),
          h('span', null, t('dialog.planning')),
        ))
        bodyChildren.push(h(Skeleton, { key: 'skeleton', lines: 3 }))
      }
      if (state.refreshing === true && phase === 'review') {
        bodyChildren.push(h('div', { className: 'dsh-cleanup-progress', key: 'replanning', role: 'status' },
          h(Spinner, null),
          h('span', null, t('dialog.replanning')),
        ))
      }
      if (phase === 'deferring') {
        bodyChildren.push(h('div', { className: 'dsh-cleanup-progress', key: 'deferring', role: 'status' },
          h(Spinner, null),
          h('span', null, t('dialog.deferring')),
        ))
      }
      // `review` renders even without a plan: an empty selection keeps the rows (and their
      // checkboxes) on screen instead of collapsing the whole list. `deleting`/`deferring` only
      // happen with a plan in hand.
      if (phase === 'review' || (plan !== null && plan !== undefined && (phase === 'deleting' || phase === 'deferring'))) {
        bodyChildren.push(h('div', { key: 'review', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
          renderReviewBody({
            t: t,
            state: state,
            catalog: catalog,
            modeLabelId: modeLabelId,
            modeGroupName: modeGroupName,
            expandedGroups: expandedGroups,
            onToggleGroup: toggleGroup,
            onToggleSelection: api.setDialogSelection,
            onSelectAll: api.selectAllDialogTargets,
            onInvert: api.invertDialogTargetSelection,
            onIncludeDescendants: api.setIncludeDescendants,
            onMode: api.setDialogMode,
            onIncludeSessions: api.setIncludeSessions,
            onTyped: api.setTypedText,
          }),
        ))
      }
      if (phase === 'review' && state.clear !== null) bodyChildren.push(renderClearReviewNote(t, state))
      if (phase === 'done') bodyChildren.push(h('div', { key: 'done' }, renderDoneBody(t, state, describedById)))
      if (phase === 'deferred') bodyChildren.push(h('div', { key: 'deferred' }, renderDeferredBody(t, state, describedById)))
      if (phase === 'failed') bodyChildren.push(h('div', { key: 'failed' }, renderFailedBody(t, state)))

      return h('div', {
        className: surface === 'settings' ? 'dsh-cleanup-overlay dsh-cleanup-overlay-inline' : 'dsh-cleanup-overlay',
        role: 'presentation',
      },
        h('div', {
          className: 'dsh-cleanup-backdrop',
          'aria-hidden': 'true',
          onMouseDown: function (event) {
            backdropDownRef.current = event.target === event.currentTarget
          },
          onClick: function (event) {
            if (event.target !== event.currentTarget) return
            if (!backdropDownRef.current) return
            backdropDownRef.current = false
            if (canDismiss) api.dismissDialog()
          },
        }),
        h('div', {
          className: 'dsh-cleanup-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          // The result summary is a live region; the dialog points at it so a
          // screen reader announces the result together with the dialog name. A
          // queued deletion shows the same distinct result state, so it is included.
          'aria-describedby': phase === 'done' || phase === 'deferred' ? describedById : undefined,
          'aria-busy': busy || state.refreshing === true ? 'true' : undefined,
          tabIndex: -1,
          ref: panelRef,
        },
          h('div', { className: 'dsh-cleanup-dialog-head' },
            h('h2', { className: 'dsh-cleanup-dialog-title', id: titleId }, dialogTitleText(t, dialogTargetList(state), state)),
            h('div', { className: 'dsh-cleanup-dialog-sub', title: dialogSubText(t, dialogTargetList(state), state, catalog) },
              dialogSubText(t, dialogTargetList(state), state, catalog)),
          ),
          h('div', { className: 'dsh-cleanup-dialog-body' }, bodyChildren),
          h('div', { className: 'dsh-cleanup-dialog-footer' }, footer),
        ),
      )
    }

    // ------------------------------------------------------------ settings page

    function WorkspacesPanel(props) {
      const t = props.t
      const state = props.state
      const store = props.store
      const onDelete = props.onDelete
      const inventory = state.inventory

      if (!inventory) {
        if (state.inventoryError) return renderErrorBlock(t, state.inventoryError, function () { store.loadInventory() })
        return h('div', { className: 'dsh-cleanup-list', 'aria-busy': 'true' },
          h('div', { className: 'dsh-cleanup-sr' }, t('page.loading')),
          h(Skeleton, { lines: 3 }),
        )
      }

      const workspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : []
      if (workspaces.length === 0) {
        return h('div', { className: 'dsh-cleanup-empty' }, t('page.empty.workspaces'))
      }

      const batch = state.selected.length > 0
        ? h('div', { className: 'dsh-cleanup-batchbar' },
          h('span', { className: 'dsh-cleanup-batchbar-text' }, plural(t, 'page.selectedCount', state.selected.length)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn',
            onClick: function () { store.clearSelection() },
          }, t('action.clearSelection')),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-danger',
            onClick: function () {
              const targets = state.selected.map(function (id) { return { kind: 'workspace', id: id } })
              onDelete(targets)
            },
          }, plural(t, 'action.deleteSelected', state.selected.length)),
        )
        : null

      const rows = workspaces.map(function (row) {
        const title = rowTitle(t, row)
        const measured = state.measured.workspaces[row.id]
        const missing = row.state === 'missing'
        const unsafe = row.state === 'unsafe'
        const blocked = Array.isArray(row.blockerCodes) && row.blockerCodes.length > 0
        const blockedTitle = blocked
          ? row.blockerCodes.map(function (code) { return localizedCode(t, 'error', code, null) }).join('\n')
          : undefined
        return h('div', { className: 'dsh-cleanup-item', key: row.id },
          h('input', {
            className: 'dsh-cleanup-check',
            type: 'checkbox',
            checked: state.selected.indexOf(row.id) !== -1,
            'aria-label': t('a11y.rowAction', { action: t('page.select'), title: title }),
            onChange: function () { store.toggleSelect(row.id) },
          }),
          h('div', { className: 'dsh-cleanup-item-main' },
            h('div', { className: 'dsh-cleanup-item-head' },
              h('span', { className: 'dsh-cleanup-item-title', title: title }, title),
              missing ? h(Badge, { tone: 'warn' }, t('badge.missing')) : null,
              unsafe ? h(Badge, { tone: 'warn', title: blockedTitle }, t('badge.unsafe')) : null,
              blocked ? h(Badge, { tone: 'error', title: blockedTitle }, t('badge.notDeletable')) : null,
            ),
            h('div', { className: 'dsh-cleanup-path', title: typeof row.path === 'string' ? row.path : '' },
              middleEllipsis(typeof row.path === 'string' ? row.path : '', 64)),
            h('div', { className: 'dsh-cleanup-item-meta' },
              h('span', null, plural(t, 'workspace.sessions', row.sessionCount)),
              h(Sep, null),
              measured && typeof measured.bytes === 'number'
                ? h('span', {
                  className: 'dsh-cleanup-size',
                  title: measured.truncated === true ? t('measure.truncated') : undefined,
                }, (measured.truncated === true ? '≥ ' : '') + formatBytes(measured.bytes))
                : h('span', null, t('measure.unmeasured')),
            ),
          ),
          h('div', { className: 'dsh-cleanup-item-actions' },
            measured && typeof measured.bytes === 'number'
              ? null
              : h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-ghost dsh-cleanup-btn-sm',
                disabled: state.measuring,
                'aria-label': t('a11y.rowAction', {
                  action: state.measuring ? t('measure.measuring') : t('measure.button'),
                  title: title,
                }),
                onClick: function () { store.measure({ workspaceIds: [row.id] }) },
              }, state.measuring ? t('measure.measuring') : t('measure.button')),
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
              'aria-label': t('a11y.rowAction', { action: t('action.delete'), title: title }),
              onClick: function () { onDelete([{ kind: 'workspace', id: row.id, title: title, path: row.path }]) },
            }, t('action.delete')),
          ),
        )
      })

      return h('div', { className: 'dsh-cleanup-panel' }, batch, h('div', { className: 'dsh-cleanup-list' }, rows))
    }

    /**
     * Inline cleanup wizard for the Sessions tab (SPEC §4.9/§10).
     *
     * It only previews candidates and hands the chosen ids to the ordinary plan flow;
     * the review dialog remains the sole confirmation. Filters are debounced in the
     * page store (300 ms, abortable, deduped), the request is capped at
     * WIZARD_PREVIEW_LIMIT candidates, and a plan holds at most WIZARD_TARGET_MAX
     * targets. Escape closes this panel only (the surrounding settings modal stays).
     */
    function SessionWizardPanel(props) {
      const t = props.t
      const state = props.state
      const store = props.store
      const inventory = props.inventory
      const catalog = props.catalog
      const onDelete = props.onDelete
      const panelRef = props.panelRef
      const id = props.id

      const filters = state.wizardFilters || defaultWizardFilters()
      const preview = state.wizardPreview || initialWizardPreview()
      const fieldErrors = preview.fieldErrors && typeof preview.fieldErrors === 'object' ? preview.fieldErrors : {}
      const candidates = Array.isArray(preview.candidates) ? preview.candidates : []
      const selected = Array.isArray(state.wizardSelected) ? state.wizardSelected : []
      const selectedSet = {}
      for (let i = 0; i < selected.length; i += 1) selectedSet[selected[i]] = true
      const notice = state.wizardNotice
      const workspaces = inventory && Array.isArray(inventory.workspaces) ? inventory.workspaces : []
      const total = typeof preview.total === 'number' ? preview.total : candidates.length
      const totals = preview.totals || { count: 0, bytes: 0 }
      const deletableRows = candidates.filter(function (row) { return row && row.deletable === true })
      const selectAllCap = Math.min(WIZARD_TARGET_MAX, deletableRows.length)
      const allDeletableSelected = selected.length > 0 && selected.length >= selectAllCap
      const truncated = preview.truncated === true
      const lowerBoundTotal = preview.status === 'ready' && (truncated || candidates.some(function (row) {
        return row && row.sizeBytes === null
      }))
      const readyEmpty = preview.status === 'ready' && candidates.length === 0
      const previewError = preview.status === 'error' ? preview.error : null

      // Escape closes the wizard without dismissing the settings modal around it.
      useEffect(function () {
        if (typeof document === 'undefined') return undefined
        function handleEscape(event) {
          if (event.defaultPrevented || event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          store.closeWizard()
        }
        document.addEventListener('keydown', handleEscape, true)
        return function () { document.removeEventListener('keydown', handleEscape, true) }
      }, [store])

      const olderId = id + '-older'
      const archivedId = id + '-archived'
      const minBytesId = id + '-min-bytes'
      const workspaceId = id + '-workspace'
      const originId = id + '-origin'
      const sortId = id + '-sort'
      const requireId = id + '-require'
      const allId = id + '-select-all'
      const blockersId = function (index) { return id + '-row-' + index + '-blockers' }
      const errorId = function (base) { return base + '-error' }

      function filterNumberRow(baseId, field, labelKey, hintKey, min, max, step) {
        const error = fieldErrors[field] || null
        const label = t(labelKey)
        return h('div', { className: 'dsh-cleanup-wizard-field', key: field },
          h('label', { className: 'dsh-cleanup-wizard-field-label', htmlFor: baseId }, label),
          h('input', {
            id: baseId,
            className: 'dsh-cleanup-input dsh-cleanup-input-sm',
            type: 'number',
            inputMode: 'numeric',
            min: min,
            max: max,
            step: step === undefined ? 1 : step,
            value: typeof filters[field] === 'string' ? filters[field] : String(filters[field] === undefined ? '' : filters[field]),
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': error ? errorId(baseId) : undefined,
            onChange: function (event) { store.setWizardFilter(field, event.target.value) },
          }),
          hintKey ? h('div', { className: 'dsh-cleanup-wizard-hint' }, t(hintKey)) : null,
          error ? h('div', { className: 'dsh-cleanup-field-error', id: errorId(baseId), role: 'alert' }, error) : null,
        )
      }

      function filterSelectRow(baseId, field, labelKey, value, options) {
        return h('div', { className: 'dsh-cleanup-wizard-field', key: field },
          h('label', { className: 'dsh-cleanup-wizard-field-label', htmlFor: baseId }, t(labelKey)),
          h('select', {
            id: baseId,
            className: 'dsh-cleanup-select',
            value: value,
            onChange: function (event) { store.setWizardFilter(field, event.target.value) },
          }, options.map(function (option) {
            const label = typeof option.label === 'string' && option.label !== '' ? option.label : t(option.labelKey)
            return h('option', { key: option.value, value: option.value }, label)
          })),
        )
      }

      const statusChildren = []
      if (preview.status === 'idle') statusChildren.push(t('sessions.wizard.idle'))
      else if (preview.status === 'loading') statusChildren.push(t('sessions.wizard.loading'))
      else if (preview.status === 'error') statusChildren.push(t('sessions.wizard.error'))
      else if (readyEmpty) statusChildren.push(t('sessions.wizard.empty'))
      else statusChildren.push(plural(t, 'sessions.wizard.announce', total, { size: formatBytes(totals.bytes) }))

      const resultHeader = preview.status === 'ready' && readyEmpty !== true
        ? h('div', { className: 'dsh-cleanup-wizard-result-head' },
          h('span', { className: 'dsh-cleanup-wizard-summary' }, plural(t, 'sessions.wizard.summary', total, {
            size: formatBytes(totals.bytes),
          })),
          truncated
            ? h('span', { className: 'dsh-cleanup-wizard-warn' }, t('sessions.wizard.truncated', { limit: formatNumber(WIZARD_PREVIEW_LIMIT) }))
            : null,
          lowerBoundTotal
            ? h('span', { className: 'dsh-cleanup-muted' }, t('sessions.wizard.lowerBound'))
            : null,
        )
        : null

      const capWarning = total > WIZARD_TARGET_MAX
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-warn', role: 'status' },
          h('span', { className: 'dsh-cleanup-banner-text' }, plural(t, 'sessions.wizard.capWarning', total, {
            max: formatNumber(WIZARD_TARGET_MAX),
          })))
        : null

      const results = preview.status === 'ready'
        ? h('div', { className: 'dsh-cleanup-wizard-results', key: 'results' },
          resultHeader,
          capWarning,
          h('div', { className: 'dsh-cleanup-wizard-selectbar' },
            h('label', { className: 'dsh-cleanup-wizard-selectall', htmlFor: allId },
              h('input', {
                id: allId,
                className: 'dsh-cleanup-check',
                type: 'checkbox',
                checked: allDeletableSelected,
                disabled: selectAllCap === 0,
                onChange: function () {
                  if (!allDeletableSelected) store.selectAllWizardCandidates()
                  else store.clearWizardSelection()
                },
              }),
              h('span', null, t('sessions.wizard.selectAll', { max: formatNumber(WIZARD_TARGET_MAX) })),
            ),
            h('span', { className: 'dsh-cleanup-muted' }, plural(t, 'sessions.wizard.selectedCount', selected.length)),
          ),
          h('div', { className: 'dsh-cleanup-wizard-list', role: 'list' },
            candidates.map(function (candidate, index) {
              const title = resolveSessionLabel(t, catalog, { id: candidate.id, cwd: candidate.cwd })
              const blocked = candidate.deletable !== true
              const blockerText = candidate.blockerCodes.map(function (code) { return sessionCodeLabel(t, code) }).join('; ')
              const age = sessionAgeDays(candidate.createdAt)
              return h('div', {
                className: 'dsh-cleanup-wizard-row' + (blocked ? ' dsh-cleanup-wizard-row-blocked' : ''),
                key: candidate.id,
                role: 'listitem',
              },
                h('input', {
                  className: 'dsh-cleanup-check',
                  type: 'checkbox',
                  checked: selectedSet[candidate.id] === true,
                  disabled: blocked,
                  title: blocked && blockerText !== '' ? blockerText : undefined,
                  'aria-label': t('a11y.rowAction', { action: t('page.select'), title: title }),
                  'aria-describedby': blocked && blockerText !== '' ? blockersId(index) : undefined,
                  onChange: function () { store.toggleWizardCandidate(candidate.id) },
                }),
                h('div', { className: 'dsh-cleanup-wizard-row-main' },
                  h('div', { className: 'dsh-cleanup-item-head' },
                    // The row title is the Session label the sidebar shows (SPEC §10); the raw id stays
                    // available on hover and in the checkbox's accessible name.
                    h('span', { className: 'dsh-cleanup-item-title', title: candidate.id }, middleEllipsis(title, 46)),
                    candidate.archived === true ? h(Badge, { tone: 'idle' }, t('badge.archived')) : null,
                    candidate.origin === 'subagent' ? h(Badge, { tone: 'idle' }, t('badge.subagent')) : null,
                    candidate.live === true ? h(Badge, { tone: 'brand' }, t('badge.live')) : null,
                    blocked ? h(Badge, { tone: 'error' }, t('badge.notDeletable')) : null,
                  ),
                  h('div', { className: 'dsh-cleanup-item-meta' },
                    h('span', { key: 'workspace', title: candidate.workspaceId || '' }, workspaceLabelFor(inventory, candidate.workspaceId, t)),
                    h(Sep, { key: 'sep-age' }),
                    h('span', { key: 'age' }, plural(t, 'sessions.wizard.age', age, { days: formatNumber(age) })),
                    h(Sep, { key: 'sep-size' }),
                    candidate.sizeBytes === null
                      ? h('span', { key: 'size' }, t('measure.unmeasured'))
                      : h('span', { className: 'dsh-cleanup-size', key: 'size' }, formatBytes(candidate.sizeBytes)),
                  ),
                  blocked && blockerText !== ''
                    ? h('div', { className: 'dsh-cleanup-wizard-blockers', id: blockersId(index) }, blockerText)
                    : null,
                ),
              )
            }),
          ),
        )
        : null

      const errorBanner = previewError
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-error', role: 'alert', key: 'error' },
          h('span', { className: 'dsh-cleanup-banner-text' }, apiErrorText(t, previewError)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
            onClick: function () { store.retryWizardPreview() },
          }, t('action.retry')))
        : null

      return h('div', {
        className: 'dsh-cleanup-wizard',
        ref: panelRef,
        tabIndex: -1,
        role: 'group',
        'aria-label': t('sessions.wizard.title'),
        'data-dsh-cleanup-wizard': '',
      },
        h('div', { className: 'dsh-cleanup-wizard-head' },
          h('h3', { className: 'dsh-cleanup-wizard-title' }, t('sessions.wizard.title')),
        ),
        h('fieldset', { className: 'dsh-cleanup-wizard-filters' },
          h('legend', { className: 'dsh-cleanup-wizard-legend' }, t('sessions.wizard.legend')),
          filterNumberRow(olderId, 'olderThanDays', 'sessions.wizard.olderThanDays', 'sessions.wizard.olderThanDaysHint', 0, WIZARD_MAX_OLDER_DAYS, 1),
          filterSelectRow(archivedId, 'archived', 'sessions.wizard.archived', filters.archived === 'only' || filters.archived === 'exclude' ? filters.archived : 'all', [
            { value: 'all', labelKey: 'sessions.wizard.archived.all' },
            { value: 'only', labelKey: 'sessions.wizard.archived.only' },
            { value: 'exclude', labelKey: 'sessions.wizard.archived.exclude' },
          ]),
          filterNumberRow(minBytesId, 'minBytesMb', 'sessions.wizard.minBytes', 'sessions.wizard.minBytesHint', 0, Math.floor(WIZARD_MAX_MIN_BYTES / BYTES_PER_MB), 1),
          filterSelectRow(workspaceId, 'workspaceId', 'sessions.wizard.workspace', typeof filters.workspaceId === 'string' ? filters.workspaceId : '',
            [{ value: '', labelKey: 'sessions.wizard.workspace.any' }].concat(workspaces.map(function (row) {
              const title = typeof row.title === 'string' && row.title !== '' ? row.title : baseName(row.path)
              return { value: row.id, label: title !== '' ? title : t('sessions.wizard.workspaceUnknown') }
            }))),
          filterSelectRow(originId, 'origin', 'sessions.wizard.origin', filters.origin === 'root' || filters.origin === 'subagent' ? filters.origin : 'all', [
            { value: 'all', labelKey: 'sessions.wizard.origin.all' },
            { value: 'root', labelKey: 'sessions.wizard.origin.root' },
            { value: 'subagent', labelKey: 'sessions.wizard.origin.subagent' },
          ]),
          h('label', { className: 'dsh-cleanup-wizard-toggle', htmlFor: requireId },
            h('input', {
              id: requireId,
              className: 'dsh-cleanup-check',
              type: 'checkbox',
              checked: filters.requireDeletable === true,
              onChange: function (event) { store.setWizardFilter('requireDeletable', event.target.checked) },
            }),
            h('span', null, t('sessions.wizard.requireDeletable')),
          ),
          h('div', { className: 'dsh-cleanup-wizard-field', key: 'sort' },
            h('label', { className: 'dsh-cleanup-wizard-field-label', htmlFor: sortId }, t('sessions.wizard.sort')),
            h('select', {
              id: sortId,
              className: 'dsh-cleanup-select',
              value: state.wizardSort === 'largest' ? 'largest' : 'oldest',
              onChange: function (event) { store.setWizardSort(event.target.value) },
            },
              h('option', { value: 'oldest' }, t('sessions.wizard.sort.oldest')),
              h('option', { value: 'largest' }, t('sessions.wizard.sort.largest')),
            ),
          ),
        ),
        h('div', { className: 'dsh-cleanup-wizard-capnote' }, t('sessions.wizard.capNote', {
          limit: formatNumber(WIZARD_PREVIEW_LIMIT),
          max: formatNumber(WIZARD_TARGET_MAX),
        })),
        h('div', {
          className: 'dsh-cleanup-sr',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'true',
          key: 'status-' + (preview.status || 'idle') + '-' + String(total),
        }, statusChildren),
        notice && notice.kind === 'cap'
          ? h('div', {
            className: 'dsh-cleanup-sr',
            role: 'status',
            'aria-live': 'polite',
            key: 'notice-cap-' + String(notice.seq),
          }, t('sessions.wizard.selectCap', { max: formatNumber(WIZARD_TARGET_MAX) }))
          : null,
        errorBanner,
        results,
        h('div', { className: 'dsh-cleanup-wizard-footer' },
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-danger',
            disabled: selected.length === 0,
            onClick: function () {
              const targets = store.wizardTargets()
              if (targets.length > 0) onDelete(targets)
            },
          }, plural(t, 'sessions.wizard.review', selected.length)),
        ),
      )
    }

    function SessionsPanel(props) {
      const t = props.t
      const state = props.state
      const store = props.store
      const onDelete = props.onDelete
      const catalog = props.catalog
      const inventory = state.inventory
      const ids = useId()
      const wizardToggleRef = useRef(null)
      const wizardPanelRef = useRef(null)
      const wizardId = ids + '-wizard'
      // Subagent logs collapse under the Session they belong to, like the review dialog does.
      const [expandedSessions, setExpandedSessions] = useState({})

      function toggleSessionGroup(key) {
        setExpandedSessions(function (previous) {
          const next = Object.assign({}, previous)
          if (next[key] === true) delete next[key]
          else next[key] = true
          return next
        })
      }

      // Wizard focus handoff: into the panel on open, back to its toggle on close.
      useEffect(function () {
        const request = state.wizardFocusRequest
        if (!request) return
        const target = request.target === 'panel' ? wizardPanelRef.current : wizardToggleRef.current
        if (target && typeof target.focus === 'function') {
          try { target.focus({ preventScroll: true }) } catch (error) { /* focus is best effort */ }
        }
        store.clearWizardFocusRequest()
      }, [state.wizardFocusRequest, store])

      if (!inventory) {
        if (state.inventoryError) return renderErrorBlock(t, state.inventoryError, function () { store.loadInventory() })
        return h('div', { className: 'dsh-cleanup-list', 'aria-busy': 'true' },
          h('div', { className: 'dsh-cleanup-sr' }, t('page.loading')),
          h(Skeleton, { lines: 3 }),
        )
      }

      const allSessions = Array.isArray(inventory.sessions) ? inventory.sessions.slice() : []
      // Sort and archive filter live in the page store so they survive tab
      // switches and pagination (the "show more" limit lives there too).
      const sort = state.sessionSort === 'oldest' || state.sessionSort === 'largest' ? state.sessionSort : 'newest'
      const filter = state.sessionFilter === 'archived' || state.sessionFilter === 'active' ? state.sessionFilter : 'all'
      const workspaceFilter = typeof state.sessionWorkspace === 'string' ? state.sessionWorkspace : SESSION_WORKSPACE_ANY
      const sessionByIdForWorkspace = Object.create(null)
      for (let i = 0; i < allSessions.length; i += 1) sessionByIdForWorkspace[allSessions[i].id] = allSessions[i]
      const filtered = allSessions
        .filter(function (session) {
          return workspaceMatchesFilter(sessionWorkspaceOf(session, sessionByIdForWorkspace), workspaceFilter)
        })
        .filter(function (session) { return sessionMatchesFilter(session, filter) })
      filtered.sort(function (left, right) { return compareSessionRows(catalog, state, sort, left, right) })

      const limit = typeof state.sessionLimit === 'number' && state.sessionLimit > 0 ? state.sessionLimit : SESSION_PAGE_SIZE
      const visible = filtered.slice(0, limit)
      const remaining = filtered.length - visible.length
      const selectedSessions = Array.isArray(state.selectedSessions) ? state.selectedSessions : []
      const selectedSet = {}
      for (let i = 0; i < selectedSessions.length; i += 1) selectedSet[selectedSessions[i]] = true

      const sortId = ids + '-sort'
      const filterId = ids + '-filter'
      const workspaceId = ids + '-workspace'
      const workspaceRows = Array.isArray(inventory.workspaces) ? inventory.workspaces : []
      const toolbar = h('div', { className: 'dsh-cleanup-toolbar' },
        // Workspace first: it narrows the list the most, so the sort/filter after it apply to a
        // smaller, more meaningful set.
        h('label', { className: 'dsh-cleanup-toolbar-field', htmlFor: workspaceId },
          h('span', null, t('sessions.workspaceFilter')),
          h('select', {
            id: workspaceId,
            className: 'dsh-cleanup-select',
            value: workspaceFilter,
            onChange: function (event) { store.setSessionWorkspace(event.target.value) },
          },
            h('option', { key: 'any', value: SESSION_WORKSPACE_ANY }, t('sessions.workspaceFilter.all')),
            h('option', { key: 'ungrouped', value: SESSION_WORKSPACE_UNGROUPED }, t('sessions.workspaceFilter.ungrouped')),
            workspaceRows.map(function (row) {
              return h('option', { key: String(row.id), value: row.id }, rowTitle(t, row))
            }),
          ),
        ),
        h('label', { className: 'dsh-cleanup-toolbar-field', htmlFor: sortId },
          h('span', null, t('sessions.sort.label')),
          h('select', {
            id: sortId,
            className: 'dsh-cleanup-select',
            value: sort,
            onChange: function (event) { store.setSessionSort(event.target.value) },
          },
            h('option', { value: 'newest' }, t('sessions.sort.newest')),
            h('option', { value: 'oldest' }, t('sessions.sort.oldest')),
            h('option', { value: 'largest' }, t('sessions.sort.largest')),
          ),
        ),
        h('label', { className: 'dsh-cleanup-toolbar-field', htmlFor: filterId },
          h('span', null, t('sessions.filter.label')),
          h('select', {
            id: filterId,
            className: 'dsh-cleanup-select',
            value: filter,
            onChange: function (event) { store.setSessionFilter(event.target.value) },
          },
            h('option', { value: 'all' }, t('sessions.filter.all')),
            h('option', { value: 'archived' }, t('sessions.filter.archived')),
            h('option', { value: 'active' }, t('sessions.filter.active')),
          ),
        ),
        sort === 'largest' ? h('span', { className: 'dsh-cleanup-muted' }, t('sessions.sort.largestHint')) : null,
        h('button', {
          ref: wizardToggleRef,
          type: 'button',
          className: 'dsh-cleanup-btn dsh-cleanup-btn-sm' + (state.wizardOpen === true ? ' dsh-cleanup-btn-accent' : ''),
          'aria-expanded': state.wizardOpen === true ? 'true' : 'false',
          'aria-controls': wizardId,
          onClick: function () {
            if (state.wizardOpen === true) store.closeWizard()
            else store.openWizard()
          },
        }, state.wizardOpen === true ? t('sessions.wizard.close') : t('sessions.wizard.action')),
      )

      const wizardPanel = state.wizardOpen === true
        ? h(SessionWizardPanel, {
          t: t,
          state: state,
          store: store,
          inventory: inventory,
          catalog: catalog,
          onDelete: onDelete,
          panelRef: wizardPanelRef,
          id: wizardId,
        })
        : null

      const batch = selectedSessions.length > 0
        ? h('div', { className: 'dsh-cleanup-batchbar' },
          h('span', { className: 'dsh-cleanup-batchbar-text' }, plural(t, 'page.selectedCount', selectedSessions.length)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn',
            onClick: function () { store.clearSessionSelection() },
          }, t('action.clearSelection')),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-danger',
            onClick: function () {
              const byId = {}
              for (let i = 0; i < allSessions.length; i += 1) byId[allSessions[i].id] = allSessions[i]
              const targets = []
              for (let i = 0; i < selectedSessions.length; i += 1) {
                const session = byId[selectedSessions[i]]
                if (!session) continue
                targets.push({
                  kind: 'session',
                  id: session.id,
                  title: resolveSessionLabel(t, catalog, { id: session.id, cwd: session.cwd }),
                  cwd: session.cwd,
                })
              }
              if (targets.length > 0) onDelete(targets)
            },
          }, plural(t, 'action.deleteSelected', selectedSessions.length)),
        )
        : null

      if (allSessions.length === 0) {
        return h('div', { className: 'dsh-cleanup-panel' }, toolbar, wizardPanel, batch,
          h('div', { className: 'dsh-cleanup-empty' }, t('page.empty.sessions')))
      }
      if (filtered.length === 0) {
        return h('div', { className: 'dsh-cleanup-panel' }, toolbar, wizardPanel, batch,
          h('div', { className: 'dsh-cleanup-empty' }, t('page.empty.sessionsFiltered')))
      }

      function renderSessionRow(session) {
        const title = resolveSessionLabel(t, catalog, { id: session.id, cwd: session.cwd })
        const measuredBytes = sessionMeasuredBytes(state, session)
        const sizeKnown = measuredBytes !== null
          ? measuredBytes
          : (typeof session.sizeBytes === 'number' ? session.sizeBytes : null)
        const sessionBlocked = Array.isArray(session.blockerCodes) && session.blockerCodes.length > 0
        const sessionBlockedTitle = sessionBlocked
          ? session.blockerCodes.map(function (code) { return localizedCode(t, 'error', code, null) }).join('\n')
          : undefined
        const cwd = typeof session.cwd === 'string' ? session.cwd : ''
        return h('div', { className: 'dsh-cleanup-item', key: session.id },
          h('input', {
            className: 'dsh-cleanup-check',
            type: 'checkbox',
            checked: selectedSet[session.id] === true,
            'aria-label': t('a11y.rowAction', { action: t('page.select'), title: title }),
            onChange: function () { store.toggleSessionSelect(session.id) },
          }),
          h('div', { className: 'dsh-cleanup-item-main' },
            h('div', { className: 'dsh-cleanup-item-head' },
              h('span', { className: 'dsh-cleanup-item-title', title: title }, title),
              session.running === true ? h(Badge, { tone: 'warn' }, t('badge.running')) : null,
              session.live === true ? h(Badge, { tone: 'brand' }, t('badge.live')) : null,
              session.archived === true ? h(Badge, { tone: 'idle' }, t('badge.archived')) : null,
              session.origin === 'subagent' ? h(Badge, { tone: 'idle' }, t('badge.subagent')) : null,
              session.deletable === false || sessionBlocked
                ? h(Badge, { tone: 'error', title: sessionBlockedTitle }, t('badge.notDeletable'))
                : null,
            ),
            cwd !== '' ? h('div', { className: 'dsh-cleanup-path', title: cwd }, middleEllipsis(cwd, 64)) : null,
            h('div', { className: 'dsh-cleanup-item-meta' },
              h('span', null, formatTime(session.createdAt) || t('common.none')),
              h(Sep, null),
              sizeKnown === null
                ? h('span', null, t('measure.unmeasured'))
                : h('span', { className: 'dsh-cleanup-size' }, formatBytes(sizeKnown)),
            ),
          ),
          h('div', { className: 'dsh-cleanup-item-actions' },
            sizeKnown === null
              ? h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-ghost dsh-cleanup-btn-sm',
                disabled: state.measuring,
                'aria-label': t('a11y.rowAction', {
                  action: state.measuring ? t('measure.measuring') : t('measure.button'),
                  title: title,
                }),
                onClick: function () { store.measure({ sessionIds: [session.id] }) },
              }, state.measuring ? t('measure.measuring') : t('measure.button'))
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
              'aria-label': t('a11y.rowAction', { action: t('action.delete'), title: title }),
              onClick: function () {
                onDelete([{ kind: 'session', id: session.id, title: title, cwd: session.cwd }])
              },
            }, t('action.delete')),
          ),
        )
      }

      // Group by Session family: a subagent log whose parent is on this page collapses under it, while
      // a log whose parent was filtered out (or is past the page limit) stays a top-level row.
      const visibleIds = Object.create(null)
      const visibleById = Object.create(null)
      for (let i = 0; i < visible.length; i += 1) {
        visibleIds[visible[i].id] = true
        visibleById[visible[i].id] = visible[i]
      }
      // Corrupt data can describe a parent cycle; such rows must stay visible instead of vanishing
      // into a group no top-level row ever reaches.
      function hasCyclicParent(session) {
        const seen = Object.create(null)
        let cursor = session
        while (cursor) {
          const parentId = typeof cursor.parentSessionId === 'string' ? cursor.parentSessionId : ''
          if (parentId === '') return false
          if (parentId === session.id) return true
          if (seen[parentId] === true) return true
          seen[parentId] = true
          cursor = visibleById[parentId]
        }
        return false
      }
      const childrenByParent = Object.create(null)
      const topLevel = []
      for (let i = 0; i < visible.length; i += 1) {
        const session = visible[i]
        const parentId = typeof session.parentSessionId === 'string' ? session.parentSessionId : ''
        if (parentId !== '' && parentId !== session.id && visibleIds[parentId] === true && hasCyclicParent(session) === false) {
          if (childrenByParent[parentId] === undefined) childrenByParent[parentId] = []
          childrenByParent[parentId].push(session)
        } else {
          topLevel.push(session)
        }
      }

      function renderSessionNode(session) {
        const children = childrenByParent[session.id] || []
        const expanded = expandedSessions[session.id] === true
        const childListId = 'dsh-cleanup-session-kids-' + domIdSafe(session.id)
        return h('div', { className: 'dsh-cleanup-session-group', key: session.id },
          renderSessionRow(session),
          children.length > 0
            ? h('div', { className: 'dsh-cleanup-target-children' },
              h('button', {
                type: 'button',
                className: 'dsh-cleanup-target-more',
                'aria-expanded': expanded ? 'true' : 'false',
                'aria-controls': childListId,
                onClick: function () { toggleSessionGroup(session.id) },
              }, (expanded ? t('dialog.groups.hide') : t('dialog.groups.show')) + ' · ' + plural(t, 'dialog.groups.descendants', children.length)),
              h('div', { id: childListId, className: 'dsh-cleanup-target-child-list' },
                expanded
                  ? children.map(function (child) { return renderSessionNode(child) })
                  : null),
            )
            : null,
        )
      }

      const rows = topLevel.map(function (session) { return renderSessionNode(session) })

      return h('div', { className: 'dsh-cleanup-panel' },
        toolbar,
        wizardPanel,
        batch,
        h('div', { className: 'dsh-cleanup-list' }, rows),
        remaining > 0
          ? h('div', null,
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn',
              onClick: function () { store.showMoreSessions() },
            }, plural(t, 'page.showMore', remaining)),
          )
          : null,
      )
    }

    function TrashPanel(props) {
      const t = props.t
      const state = props.state
      const store = props.store
      const trash = state.trash
      const actionError = state.actionError
      const confirmPurge = state.confirmPurge === undefined ? null : state.confirmPurge

      // An armed "delete permanently" must be disarmed by an outside click,
      // Escape, or the window losing focus; the cooldown itself lives in the store.
      // This hook must run unconditionally, before the loading early return.
      useEffect(function () {
        if (confirmPurge === null || typeof document === 'undefined') return undefined
        function insideArmedControl(node) {
          return !!(node && typeof node.closest === 'function' && node.closest('[data-dsh-cleanup-confirm]'))
        }
        function handlePointerDown(event) {
          if (insideArmedControl(event.target)) return
          store.setConfirmPurge(null)
        }
        function handleKeyDown(event) {
          if (event.key === 'Escape' || event.key === 'Esc') store.setConfirmPurge(null)
        }
        function handleWindowBlur() { store.setConfirmPurge(null) }
        document.addEventListener('mousedown', handlePointerDown, true)
        document.addEventListener('keydown', handleKeyDown, true)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('blur', handleWindowBlur)
        }
        return function () {
          document.removeEventListener('mousedown', handlePointerDown, true)
          document.removeEventListener('keydown', handleKeyDown, true)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('blur', handleWindowBlur)
          }
        }
      }, [confirmPurge, store])

      if (!trash) {
        if (state.trashError) return renderErrorBlock(t, state.trashError, function () { store.loadTrash() })
        return h('div', { className: 'dsh-cleanup-list', 'aria-busy': 'true' },
          h('div', { className: 'dsh-cleanup-sr' }, t('page.loading')),
          h(Skeleton, { lines: 3 }),
        )
      }

      const entries = Array.isArray(trash.entries) ? trash.entries : []
      const totals = trash.totals && typeof trash.totals === 'object' ? trash.totals : {}
      const confirmAll = confirmPurge === 'all'
      const confirmSuggested = confirmPurge === 'suggest'
      const busy = state.actionBusy !== null && state.actionBusy !== undefined

      // P1 item 2: lifecycle warnings from `inventory.trash` (never auto-deletes). The
      // configured limits come from the settings tab's fetch when it has landed.
      const inventoryTrash = state.inventory && state.inventory.trash ? state.inventory.trash : null
      const overRetention = !!(inventoryTrash && inventoryTrash.overRetention === true)
      const overCapacity = !!(inventoryTrash && inventoryTrash.overCapacity === true)
      const retentionWarned = overRetention || overCapacity
      const settingsValues = state.settings && typeof state.settings === 'object' ? state.settings : null
      const configuredMaxBytes = settingsValues && typeof settingsValues.trashMaxBytes === 'number' ? settingsValues.trashMaxBytes : null
      const configuredMaxDays = settingsValues && typeof settingsValues.trashRetentionDays === 'number' ? settingsValues.trashRetentionDays : null
      const oldestAgeDays = trashAgeDays(inventoryTrash && inventoryTrash.oldestMovedAt)
      const suggestedIds = inventoryTrash && Array.isArray(inventoryTrash.suggestedEntryIds)
        ? inventoryTrash.suggestedEntryIds
        : []
      const suggestedCount = suggestedIds.length

      function entryTitle(entry) {
        if (!entry) return ''
        if (typeof entry.title === 'string' && entry.title !== '') return entry.title
        return baseName(entry.originalPath)
      }

      let armedTitle = ''
      for (let i = 0; i < entries.length; i += 1) {
        if (String(entries[i].id) === confirmPurge) { armedTitle = entryTitle(entries[i]); break }
      }

      const head = h('div', { className: 'dsh-cleanup-panel-head' },
        h('span', null, plural(t, 'trash.summary', typeof totals.entries === 'number' ? totals.entries : entries.length, {
          size: formatBytes(typeof totals.bytes === 'number' ? totals.bytes : 0),
        })),
        entries.length > 0 || confirmAll
          ? h('div', { className: 'dsh-cleanup-item-actions' },
            confirmAll
              ? h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn',
                'data-dsh-cleanup-confirm': 'all',
                onClick: function () { store.setConfirmPurge(null) },
              }, t('action.cancel'))
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-danger dsh-cleanup-btn-sm',
              disabled: busy,
              'data-dsh-cleanup-confirm': confirmAll ? 'all' : undefined,
              onClick: function () { store.requestPurgeAll() },
            }, confirmAll ? t('action.emptyTrashConfirm') : t('action.emptyTrash')),
          )
          : null,
      )

      const armedNotice = confirmAll
        ? t('trash.purgeAllArmed')
        : (confirmSuggested
          ? plural(t, 'trash.retention.armed', suggestedCount)
          : (confirmPurge !== null ? t('trash.purgeArmed', { title: armedTitle || t('common.none') }) : ''))
      const actionNotice = state.actionNotice
      let actionNoticeText = ''
      if (actionNotice && actionNotice.kind === 'restored') {
        actionNoticeText = t('trash.announce.restored', { title: actionNotice.title || t('common.none') })
      } else if (actionNotice && actionNotice.kind === 'purged') {
        actionNoticeText = plural(t, 'trash.announce.purged', actionNotice.count)
      }
      // Two sr-only polite live regions. The armed-region key changes
      // with the armed target so a repeated arming is announced again.
      const armedStatus = h('div', {
        key: 'armed-' + (confirmPurge === null ? 'none' : String(confirmPurge)),
        className: 'dsh-cleanup-sr',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }, armedNotice)
      const actionStatus = h('div', {
        key: 'notice-' + (actionNotice ? String(actionNotice.seq) : 'none'),
        className: 'dsh-cleanup-sr',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }, actionNoticeText)

      const errorBanner = actionError || state.trashError
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-error', role: 'alert' },
          h('span', { className: 'dsh-cleanup-banner-text' }, apiErrorText(t, actionError || state.trashError)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
            onClick: function () {
              if (actionError) store.retryAction()
              else store.loadTrash()
            },
          }, t('action.retry')),
        )
        : null

      let retentionBanner = null
      if (retentionWarned) {
        const lines = []
        if (overCapacity) {
          const sizeText = formatBytes(inventoryTrash && typeof inventoryTrash.bytes === 'number' ? inventoryTrash.bytes : 0)
          lines.push(h('div', { key: 'capacity' },
            configuredMaxBytes !== null && configuredMaxBytes > 0
              ? t('trash.retention.capacity', { size: sizeText, max: formatBytes(configuredMaxBytes) })
              : t('trash.retention.capacityGeneric', { size: sizeText })))
        }
        if (overRetention) {
          const days = formatNumber(oldestAgeDays)
          lines.push(h('div', { key: 'age' },
            configuredMaxDays !== null && configuredMaxDays > 0
              ? plural(t, 'trash.retention.age', oldestAgeDays, { days: days, maxDays: formatNumber(configuredMaxDays) })
              : plural(t, 'trash.retention.ageGeneric', oldestAgeDays, { days: days })))
        }
        lines.push(h('div', { key: 'note', className: 'dsh-cleanup-muted' }, t('trash.retention.note')))
        const retentionActions = []
        if (overCapacity && suggestedCount === 0) {
          retentionActions.push(h('div', { key: 'manual', className: 'dsh-cleanup-muted' }, t('trash.retention.manual')))
        }
        if (suggestedCount > 0) {
          retentionActions.push(h('button', {
            key: 'purge-suggested',
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-danger dsh-cleanup-btn-sm',
            disabled: busy,
            'data-dsh-cleanup-confirm': confirmSuggested ? 'suggest' : undefined,
            onClick: function () { store.requestPurgeSuggested() },
          }, confirmSuggested
            ? plural(t, 'trash.retention.armed', suggestedCount)
            : plural(t, 'trash.retention.purgeSuggested', suggestedCount)))
        }
        retentionBanner = h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-warn dsh-cleanup-retention', role: 'status', key: 'retention' },
          h('div', { className: 'dsh-cleanup-banner-text' },
            h('strong', { style: { display: 'block' } }, t('trash.retention.title')),
            lines,
          ),
          retentionActions.length > 0 ? h('div', { className: 'dsh-cleanup-item-actions' }, retentionActions) : null,
        )
      }

      if (entries.length === 0) {
        return h('div', { className: 'dsh-cleanup-panel' }, armedStatus, actionStatus, retentionBanner, head, errorBanner,
          h('div', { className: 'dsh-cleanup-empty' }, t('page.empty.trash')))
      }

      const rows = entries.map(function (entry) {
        const id = String(entry.id)
        const confirming = confirmPurge === id
        const entryBusy = busy && state.actionBusy.entryId === id
        const restorable = entry.restorable === true
        const rawTitle = typeof entry.title === 'string' && entry.title !== ''
          ? entry.title
          : baseName(entry.originalPath)
        const kindText = entry.kind === 'workspace-dir'
          ? t('dialog.items.workspace')
          : (entry.kind === 'session' ? t('dialog.items.session') : null)
        const title = rawTitle !== '' ? rawTitle : (kindText || t('common.none'))
        const originalPath = typeof entry.originalPath === 'string' ? entry.originalPath : ''
        const restoreNote = restorable
          ? null
          : localizedCode(t, 'error', entry.restorableCode, t('trash.restoreUnavailable'))
        return h('div', { className: 'dsh-cleanup-item', key: id },
          h('div', { className: 'dsh-cleanup-item-main' },
            h('div', { className: 'dsh-cleanup-item-head' },
              h('span', { className: 'dsh-cleanup-item-title', title: title }, title),
              kindText ? h(Badge, { tone: 'idle' }, kindText) : null,
              entry.origin === 'subagent' ? h(Badge, { tone: 'idle' }, t('badge.subagent')) : null,
              restorable ? null : h(Badge, { tone: 'warn' }, t('trash.restoreUnavailable')),
            ),
            originalPath !== ''
              ? h('div', { className: 'dsh-cleanup-path', title: originalPath }, middleEllipsis(originalPath, 64))
              : null,
            h('div', { className: 'dsh-cleanup-item-meta' },
              h('span', null, t('trash.movedAt') + ' ' + (formatTime(entry.movedAt) || t('common.none'))),
              h(Sep, null),
              h('span', { className: 'dsh-cleanup-size' }, formatBytes(entry.bytes)),
              typeof entry.parentSessionId === 'string' && entry.parentSessionId !== ''
                ? h('span', {
                  className: 'dsh-cleanup-muted',
                  title: entry.parentSessionId,
                }, t('trash.parentSession', { id: shortId(entry.parentSessionId) }))
                : null,
              restoreNote ? h('span', { className: 'dsh-cleanup-muted' }, restoreNote) : null,
            ),
          ),
          h('div', { className: 'dsh-cleanup-item-actions' },
            confirmAll ? null : (confirming
              ? h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                disabled: busy,
                'data-dsh-cleanup-confirm': id,
                onClick: function () { store.setConfirmPurge(null) },
              }, t('action.cancel'))
              : (restorable
                ? h('button', {
                  type: 'button',
                  className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                  disabled: busy,
                  'aria-label': t('a11y.rowAction', { action: t('action.restore'), title: title }),
                  onClick: function () { store.restoreEntry(id) },
                }, entryBusy ? t('common.working') : t('action.restore'))
                : null)),
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-danger dsh-cleanup-btn-sm',
              disabled: busy,
              'data-dsh-cleanup-confirm': confirming ? id : undefined,
              'aria-label': t('a11y.rowAction', {
                action: confirming ? t('action.purgeConfirm') : t('action.purge'),
                title: title,
              }),
              onClick: function () { store.requestPurge(id) },
            }, confirming ? t('action.purgeConfirm') : t('action.purge')),
          ),
        )
      })

      return h('div', { className: 'dsh-cleanup-panel' }, armedStatus, actionStatus, retentionBanner, head, errorBanner, h('div', { className: 'dsh-cleanup-list' }, rows))
    }

    /** One-line "last start processed N items (M failed)" summary. */
    /** Processed/skipped/failed counts plus the total item count of one lastRun (F3). */
    function deferredLastRunStats(lastRun) {
      const results = lastRun && Array.isArray(lastRun.results)
        ? lastRun.results.filter(function (result) { return result && typeof result === 'object' })
        : []
      let skipped = 0
      let failed = 0
      let itemTotal = 0
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i]
        if (result.status === 'skipped') skipped += 1
        if (result.status === 'failed') failed += 1
        // F3: count what the entry actually touched — its `items` when it executed,
        // otherwise the targets it attempted — never "one item per result".
        if (Array.isArray(result.items) && result.items.length > 0) itemTotal += result.items.length
        else if (Array.isArray(result.targets) && result.targets.length > 0) itemTotal += result.targets.length
        else itemTotal += 1
      }
      return { results: results, count: results.length, skipped: skipped, failed: failed, itemTotal: itemTotal }
    }

    /** Results worth expanding: skipped/failed, or executed with a failure code (partial failure). */
    function deferredLastRunAttention(results) {
      const attention = []
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i]
        if (!result || typeof result !== 'object') continue
        if (result.status === 'skipped' || result.status === 'failed' || (typeof result.code === 'string' && result.code !== '')) {
          attention.push(result)
        }
      }
      return attention
    }

    /**
     * Settings-page deferred-deletion notice (task-9).
     *
     * Persistent line above the tabs while the queue is non-empty, an expandable
     * per-entry list with per-entry cancel plus "cancel all" (two-step + cooldown,
     * like the trash purge), an inline error/retry, the last-start summary with an
     * expandable non-success list, and a "Show details" toggle whose button is the
     * focus handoff target after a successful cancel.
     *
     * The cancel/armed/cancelled live announcements live in the always-mounted page
     * (CleanupPage), not here: this component can disappear with the last entry.
     */
    function DeferredBanner(props) {
      const t = props.t
      const state = props.state
      const store = props.store
      const catalog = props.catalog
      const ids = useId()
      const listId = ids + '-deferred-list'
      const resultsId = ids + '-deferred-results'
      const inventory = state.inventory
      const inventoryDeferred = inventory && inventory.deferred ? inventory.deferred : null
      const count = inventoryDeferred && typeof inventoryDeferred.count === 'number' && inventoryDeferred.count > 0
        ? inventoryDeferred.count
        : 0
      const retained = state.deferred && Array.isArray(state.deferred.retained) ? state.deferred.retained : []
      const inventoryRetained = inventoryDeferred && typeof inventoryDeferred.retained === 'number' && inventoryDeferred.retained > 0
        ? inventoryDeferred.retained
        : 0
      const retainedCount = retained.length > 0 ? retained.length : inventoryRetained
      const retainedConfirm = state.retainedConfirm === undefined ? null : state.retainedConfirm
      const retainedBusy = state.retainedActionBusy !== null && state.retainedActionBusy !== undefined
      const retainedLoaded = state.deferredLoaded === true
      const lastRun = (state.deferred && state.deferred.lastRun) || (inventoryDeferred && inventoryDeferred.lastRun) || null
      const lastRunStats = deferredLastRunStats(lastRun)
      const attention = deferredLastRunAttention(lastRunStats.results)
      const confirmValue = state.deferredConfirm === undefined ? null : state.deferredConfirm
      const confirmAll = confirmValue === 'all'
      const busy = state.deferredActionBusy !== null && state.deferredActionBusy !== undefined
      const expanded = state.deferredExpanded === true
      const detailsExpanded = state.deferredLastRunExpanded === true
      const entries = state.deferred && Array.isArray(state.deferred.entries) ? state.deferred.entries : []
      const workspaceLabels = deferredWorkspaceLabels(inventory)

      // Same disarm contract as the trash purge: outside click, Escape, window blur.
      // Called unconditionally (hooks order) and inert while nothing is armed.
      useEffect(function () {
        if (confirmValue === null || typeof document === 'undefined') return undefined
        function insideArmedControl(node) {
          return !!(node && typeof node.closest === 'function' && node.closest('[data-dsh-cleanup-deferred-confirm]'))
        }
        function handlePointerDown(event) {
          if (insideArmedControl(event.target)) return
          store.setDeferredConfirm(null)
        }
        function handleKeyDown(event) {
          if (event.key === 'Escape' || event.key === 'Esc') store.setDeferredConfirm(null)
        }
        function handleWindowBlur() { store.setDeferredConfirm(null) }
        document.addEventListener('mousedown', handlePointerDown, true)
        document.addEventListener('keydown', handleKeyDown, true)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('blur', handleWindowBlur)
        }
        return function () {
          document.removeEventListener('mousedown', handlePointerDown, true)
          document.removeEventListener('keydown', handleKeyDown, true)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('blur', handleWindowBlur)
          }
        }
      }, [confirmValue, store])

      // The retained arm follows the same disarm contract as the queue cancel arm.
      useEffect(function () {
        if (retainedConfirm === null || typeof document === 'undefined') return undefined
        function insideArmedControl(node) {
          return !!(node && typeof node.closest === 'function' && node.closest('[data-dsh-cleanup-retained-confirm]'))
        }
        function handlePointerDown(event) {
          if (insideArmedControl(event.target)) return
          store.setRetainedConfirm(null)
        }
        function handleKeyDown(event) {
          if (event.key === 'Escape' || event.key === 'Esc') store.setRetainedConfirm(null)
        }
        function handleWindowBlur() { store.setRetainedConfirm(null) }
        document.addEventListener('mousedown', handlePointerDown, true)
        document.addEventListener('keydown', handleKeyDown, true)
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('blur', handleWindowBlur)
        }
        return function () {
          document.removeEventListener('mousedown', handlePointerDown, true)
          document.removeEventListener('keydown', handleKeyDown, true)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('blur', handleWindowBlur)
          }
        }
      }, [retainedConfirm, store])

      // F8: an armed "cancel all" must not survive the queue emptying (or this banner
      // unmounting) — otherwise one later click would cancel a newly queued batch.
      useEffect(function () {
        if (count > 0) return undefined
        if (confirmValue !== null) store.setDeferredConfirm(null)
        return undefined
      }, [count, confirmValue, store])
      useEffect(function () {
        return function () {
          let snapshot = null
          try { snapshot = store.getSnapshot ? store.getSnapshot() : null } catch (error) { snapshot = null }
          if (snapshot && snapshot.deferredConfirm !== null && snapshot.deferredConfirm !== undefined) {
            try { store.setDeferredConfirm(null) } catch (error) { /* page is being disposed */ }
          }
        }
      }, [store])

      if (count <= 0 && lastRunStats.count === 0 && retainedCount <= 0) return null

      const showHead = count > 0 || retainedCount > 0
      const headText = []
      if (count > 0) headText.push(h('span', { key: 'queued' }, plural(t, 'deferred.notice', count)))
      if (retainedCount > 0) {
        if (count > 0) headText.push(h(Sep, { key: 'retained-sep' }))
        headText.push(h('span', { key: 'retained', className: 'dsh-cleanup-deferred-listsum' }, plural(t, 'deferred.retainedNotice', retainedCount)))
      }
      const head = showHead
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-warn dsh-cleanup-deferred-banner', key: 'notice' },
          h('span', { className: 'dsh-cleanup-banner-text' }, headText),
          h('div', { className: 'dsh-cleanup-item-actions' },
            h('button', {
              key: 'toggle',
              ref: props.toggleRef,
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-controls': listId,
              onClick: function () { store.toggleDeferredExpanded() },
            }, expanded ? t('deferred.hide') : t('deferred.show')),
            confirmAll
              ? h('button', {
                key: 'disarm-all',
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                'data-dsh-cleanup-deferred-confirm': 'all',
                onClick: function () { store.setDeferredConfirm(null) },
              }, t('action.cancel'))
              : null,
            count > 0
              ? h('button', {
                key: 'cancel-all',
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-danger dsh-cleanup-btn-sm',
                disabled: busy,
                'data-dsh-cleanup-deferred-confirm': confirmAll ? 'all' : undefined,
                onClick: function () { store.requestDeferredCancelAll() },
              }, confirmAll ? t('deferred.cancelAllConfirm') : t('deferred.cancelAll'))
              : null,
          ),
        )
        : null

      const errorBanner = (state.deferredActionError || state.retainedActionError)
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-error', role: 'alert', key: 'error' },
          h('span', { className: 'dsh-cleanup-banner-text' }, apiErrorText(t, state.retainedActionError || state.deferredActionError)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
            onClick: function () {
              if (state.retainedActionError) store.retryRetainedAction()
              else store.retryDeferredAction()
            },
          }, t('action.retry')),
        )
        : null

      // F3: one-line last-start summary + expandable non-successful results.
      let lastRunBlock = null
      if (lastRunStats.count > 0) {
        const lineChildren = [
          h('span', { key: 'processed' }, plural(t, 'deferred.lastRun', lastRunStats.count, {
            items: plural(t, 'deferred.lastRunItems', lastRunStats.itemTotal),
          })),
        ]
        if (lastRunStats.skipped > 0) {
          lineChildren.push(h(Sep, { key: 'sep-skipped' }))
          lineChildren.push(h('span', { key: 'skipped' }, plural(t, 'deferred.lastRunSkipped', lastRunStats.skipped)))
        }
        if (lastRunStats.failed > 0) {
          lineChildren.push(h(Sep, { key: 'sep-failed' }))
          lineChildren.push(h('span', { key: 'failed' }, plural(t, 'deferred.lastRunFailed', lastRunStats.failed)))
        }
        const blockChildren = [
          h('div', { className: 'dsh-cleanup-deferred-lastrun', role: 'status', key: 'line' }, lineChildren),
        ]
        if (attention.length > 0) {
          blockChildren.push(h('div', { className: 'dsh-cleanup-deferred-lastrun-actions', key: 'toggle' },
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-sm dsh-cleanup-btn-ghost',
              'aria-expanded': detailsExpanded ? 'true' : 'false',
              'aria-controls': resultsId,
              onClick: function () { store.toggleDeferredLastRunExpanded() },
            }, detailsExpanded ? t('deferred.hideDetails') : t('deferred.showDetails')),
          ))
        }
        if (detailsExpanded && attention.length > 0) {
          blockChildren.push(h('ul', { className: 'dsh-cleanup-deferred-results', key: 'results', id: resultsId },
            attention.map(function (result, index) {
              const status = typeof result.status === 'string' && result.status !== '' ? result.status : 'failed'
              const statusKey = 'deferred.status.' + status
              const statusText = hasKey(statusKey) ? t(statusKey) : status
              const targets = Array.isArray(result.targets) ? result.targets : []
              const shownTargets = targets.slice(0, DEFERRED_TARGETS_MAX)
              const hiddenTargets = targets.length - shownTargets.length
              const detail = localizedCode(t, 'error', result.code, result.reason)
              const tone = status === 'failed' ? 'error' : 'warn'
              return h('li', { className: 'dsh-cleanup-deferred-result', key: 'result-' + index },
                h('div', { className: 'dsh-cleanup-deferred-result-head' },
                  h(Badge, { tone: tone }, statusText),
                  h('span', { className: 'dsh-cleanup-deferred-result-detail' }, detail),
                ),
                h('div', { className: 'dsh-cleanup-item-meta' },
                  h('span', null, t('deferred.mode', { mode: deferredModeText(t, result.mode) })),
                  shownTargets.length > 0 ? h(Sep, null) : null,
                  shownTargets.map(function (target, targetIndex) {
                    return h('span', { key: 'target-' + targetIndex }, deferredTargetLabel(t, catalog, workspaceLabels, target))
                  }),
                  hiddenTargets > 0
                    ? h('span', { className: 'dsh-cleanup-muted' }, plural(t, 'deferred.moreTargets', hiddenTargets))
                    : null,
                ),
              )
            }),
          ))
        }
        lastRunBlock = h('div', { className: 'dsh-cleanup-deferred-lastrun-block', key: 'last-run' }, blockChildren)
      }

      let list = null
      let listSummary = null
      if (count > 0 && expanded) {
        if (state.deferredLoaded !== true && state.deferredLoading === true) {
          list = h('div', { className: 'dsh-cleanup-list', key: 'loading', 'aria-busy': 'true' },
            h('div', { className: 'dsh-cleanup-sr' }, t('deferred.loading')),
            h(Skeleton, { lines: 2 }),
          )
        } else if (state.deferredLoaded !== true && state.deferredError) {
          list = h('div', { key: 'load-error' }, renderErrorBlock(t, state.deferredError, function () { store.loadDeferred() }))
        } else if (entries.length === 0) {
          list = h('div', { className: 'dsh-cleanup-empty', key: 'empty' }, t('deferred.empty'))
        } else {
          let totalTargets = 0
          for (let i = 0; i < entries.length; i += 1) {
            totalTargets += Array.isArray(entries[i].targets) ? entries[i].targets.length : 0
          }
          listSummary = h('div', { className: 'dsh-cleanup-deferred-listsum', key: 'summary' },
            plural(t, 'deferred.listTargets', totalTargets))
          list = h('ul', { className: 'dsh-cleanup-deferred-list', key: 'list' },
            entries.map(function (entry, entryIndex) {
              const targets = Array.isArray(entry.targets) ? entry.targets : []
              const shownTargets = targets.slice(0, DEFERRED_TARGETS_MAX)
              const hiddenTargets = targets.length - shownTargets.length
              const entryTitle = plural(t, 'deferred.entryTitle', targets.length)
              const targetsId = listId + '-entry-' + entryIndex + '-targets'
              const confirming = confirmValue === entry.id
              const entryBusy = busy && state.deferredActionBusy === entry.id
              const cancelAction = confirming ? t('deferred.cancelConfirm') : t('action.cancel')
              return h('li', { className: 'dsh-cleanup-deferred-entry', key: entry.id || 'entry-' + entryIndex },
                h('div', { className: 'dsh-cleanup-deferred-entry-main' },
                  h('div', { className: 'dsh-cleanup-item-meta' },
                    h('span', null, t('deferred.queuedAt', { time: formatTime(entry.queuedAt) || t('common.none') })),
                    h(Sep, null),
                    h('span', null, t('deferred.mode', { mode: deferredModeText(t, entry.mode) })),
                    h(Sep, null),
                    h('span', null, entryTitle),
                  ),
                  // F6: the cancel button points at this list for its full target context.
                  h('div', { className: 'dsh-cleanup-item-meta', id: targetsId },
                    shownTargets.map(function (target, targetIndex) {
                      return h('span', { key: 'target-' + targetIndex }, deferredTargetLabel(t, catalog, workspaceLabels, target))
                    }),
                    hiddenTargets > 0
                      ? h('span', { className: 'dsh-cleanup-muted' }, plural(t, 'deferred.moreTargets', hiddenTargets))
                      : null,
                  ),
                ),
                h('div', { className: 'dsh-cleanup-item-actions' },
                  confirming
                    ? h('button', {
                      key: 'disarm',
                      type: 'button',
                      className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                      disabled: busy,
                      'data-dsh-cleanup-deferred-confirm': entry.id,
                      'aria-describedby': targetsId,
                      onClick: function () { store.setDeferredConfirm(null) },
                    }, t('action.cancel'))
                    : null,
                  h('button', {
                    key: 'cancel',
                    type: 'button',
                    className: 'dsh-cleanup-btn dsh-cleanup-btn-danger dsh-cleanup-btn-sm',
                    disabled: busy || (confirmAll && !confirming),
                    'data-dsh-cleanup-deferred-confirm': confirming ? entry.id : undefined,
                    'aria-label': t('a11y.rowAction', { action: cancelAction, title: entryTitle }),
                    'aria-describedby': targetsId,
                    onClick: function () { store.requestDeferredCancel(entry.id) },
                  }, entryBusy ? t('common.working') : (confirming ? t('deferred.cancelConfirm') : t('action.cancel'))),
                ),
              )
            }),
          )
        }
      }

      // P1 item 3: skipped/failed entries kept from the last startup run. Requeue moves
      // one back into the active queue; forgetting goes through the same cancel route.
      let retainedSection = null
      if (expanded && (retainedCount > 0 || retainedLoaded)) {
        if (retained.length === 0) {
          retainedSection = h('div', { className: 'dsh-cleanup-deferred-retained', key: 'retained' },
            h('div', {
              className: 'dsh-cleanup-section-title',
              ref: props.retainedHeadingRef,
              tabIndex: -1,
              'data-dsh-cleanup-retained-heading': '',
            }, t('deferred.retained.title')),
            h('div', { className: 'dsh-cleanup-empty' }, t('deferred.retained.empty')),
          )
        } else {
          retainedSection = h('div', { className: 'dsh-cleanup-deferred-retained', key: 'retained' },
            h('div', {
              className: 'dsh-cleanup-section-title',
              ref: props.retainedHeadingRef,
              tabIndex: -1,
              'data-dsh-cleanup-retained-heading': '',
            }, t('deferred.retained.title')),
            h('ul', { className: 'dsh-cleanup-deferred-list' }, retained.map(function (record, recordIndex) {
              const targets = Array.isArray(record.targets) ? record.targets : []
              const shownTargets = targets.slice(0, DEFERRED_TARGETS_MAX)
              const hiddenTargets = targets.length - shownTargets.length
              const statusText = t(record.status === 'failed' ? 'deferred.status.failed' : 'deferred.status.skipped')
              const statusTone = record.status === 'failed' ? 'error' : 'warn'
              const detailText = localizedCode(t, 'error', record.code, record.reason !== '' ? record.reason : statusText)
              const summary = auditTargetsLabel(t, catalog, workspaceLabels, targets, DEFERRED_TARGETS_MAX)
              const rowTitleText = summary !== '' ? summary : plural(t, 'deferred.entryTitle', targets.length)
              const armedAction = retainedConfirm && retainedConfirm.id === record.id ? retainedConfirm.action : null
              const entryBusy = retainedBusy && state.retainedActionBusy.entryId === record.id
              const anyBusy = retainedBusy || busy
              const targetsId = listId + '-retained-' + recordIndex + '-targets'
              const requeueLabel = armedAction === 'requeue' ? t('deferred.retained.requeueConfirm') : t('deferred.retained.requeue')
              const forgetLabel = armedAction === 'forget' ? t('deferred.retained.forgetConfirm') : t('deferred.retained.forget')
              return h('li', {
                className: 'dsh-cleanup-deferred-entry',
                key: 'retained-' + record.id,
                'data-dsh-cleanup-retained-row': record.id,
              },
                h('div', { className: 'dsh-cleanup-deferred-entry-main' },
                  h('div', { className: 'dsh-cleanup-item-head' },
                    h(Badge, { tone: statusTone }, statusText),
                    h('span', { className: 'dsh-cleanup-item-title' }, plural(t, 'deferred.entryTitle', targets.length)),
                    h('span', { className: 'dsh-cleanup-deferred-listsum' },
                      t('deferred.retainedAt', { time: formatTime(record.at) || t('common.none') })),
                    h(Sep, null),
                    h('span', { className: 'dsh-cleanup-deferred-listsum' }, t('deferred.mode', { mode: deferredModeText(t, record.mode) })),
                  ),
                  h('div', { className: 'dsh-cleanup-deferred-result-detail' }, detailText),
                  h('div', { className: 'dsh-cleanup-item-meta', id: targetsId },
                    shownTargets.map(function (target, targetIndex) {
                      return h('span', { key: 'target-' + targetIndex }, deferredTargetLabel(t, catalog, workspaceLabels, target))
                    }),
                    hiddenTargets > 0
                      ? h('span', { className: 'dsh-cleanup-muted' }, plural(t, 'deferred.moreTargets', hiddenTargets))
                      : null,
                  ),
                ),
                h('div', { className: 'dsh-cleanup-item-actions' },
                  armedAction !== null
                    ? h('button', {
                      key: 'disarm',
                      type: 'button',
                      className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                      disabled: anyBusy,
                      'data-dsh-cleanup-retained-confirm': armedAction + ':' + record.id,
                      onClick: function () { store.setRetainedConfirm(null) },
                    }, t('action.cancel'))
                    : null,
                  h('button', {
                    key: 'requeue',
                    type: 'button',
                    className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                    'data-dsh-cleanup-retained-action': '',
                    disabled: anyBusy || (retainedConfirm !== null && armedAction !== 'requeue'),
                    'data-dsh-cleanup-retained-confirm': armedAction === 'requeue' ? 'requeue:' + record.id : undefined,
                    'aria-label': t('a11y.rowAction', { action: requeueLabel, title: rowTitleText }),
                    'aria-describedby': targetsId,
                    onClick: function () { store.requestRetainedRequeue(record.id) },
                  }, entryBusy && retainedConfirm === null ? t('common.working') : requeueLabel),
                  h('button', {
                    key: 'forget',
                    type: 'button',
                    className: 'dsh-cleanup-btn dsh-cleanup-btn-danger dsh-cleanup-btn-sm',
                    disabled: anyBusy || (retainedConfirm !== null && armedAction !== 'forget'),
                    'data-dsh-cleanup-retained-confirm': armedAction === 'forget' ? 'forget:' + record.id : undefined,
                    'aria-label': t('a11y.rowAction', { action: forgetLabel, title: rowTitleText }),
                    'aria-describedby': targetsId,
                    onClick: function () { store.requestRetainedForget(record.id) },
                  }, forgetLabel),
                ),
              )
            })),
          )
        }
      }

      return h('div', { className: 'dsh-cleanup-deferred', role: 'group', 'aria-label': t('deferred.section') },
        head,
        errorBanner,
        lastRunBlock,
        // aria-controls from the Show toggle must always resolve, so the id lives
        // on a container that exists while the queue or the retained list is non-empty.
        count > 0 || retainedCount > 0 ? h('div', { id: listId }, listSummary, list, retainedSection) : null,
      )
    }

    /**
     * One numeric settings row: label + hint on the left, validated input on the right.
     * Errors are rendered under the control and wired through aria-describedby.
     */
    function SettingsNumberRow(props) {
      const t = props.t
      const field = props.field
      const error = props.error || null
      const errorId = props.inputId + '-error'
      const label = settingsFieldLabel(t, field)
      const hintKey = 'settings.field.' + field + 'Hint'
      return h('div', { className: 'dsh-cleanup-setting', key: field },
        h('div', { className: 'dsh-cleanup-setting-main' },
          h('label', { className: 'dsh-cleanup-setting-label', htmlFor: props.inputId }, label),
          hasKey(hintKey) ? h('div', { className: 'dsh-cleanup-setting-hint' }, t(hintKey)) : null,
        ),
        h('div', { className: 'dsh-cleanup-setting-control' },
          h('input', {
            id: props.inputId,
            className: 'dsh-cleanup-input dsh-cleanup-input-sm',
            type: 'number',
            inputMode: 'numeric',
            min: props.min,
            max: props.max,
            step: props.step,
            value: props.value,
            disabled: props.disabled === true,
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': error ? errorId : undefined,
            'aria-label': label,
            onChange: function (event) { props.onChange(event.target.value) },
          }),
        ),
        error ? h('div', { className: 'dsh-cleanup-field-error', id: errorId, role: 'alert' }, error) : null,
      )
    }

    /** One boolean settings row: label + hint on the left, checkbox on the right. */
    function SettingsToggleRow(props) {
      const t = props.t
      const field = props.field
      const label = settingsFieldLabel(t, field)
      const hintKey = 'settings.field.' + field + 'Hint'
      return h('div', { className: 'dsh-cleanup-setting', key: field },
        h('div', { className: 'dsh-cleanup-setting-main' },
          h('span', { className: 'dsh-cleanup-setting-label', id: props.inputId + '-label' }, label),
          hasKey(hintKey) ? h('div', { className: 'dsh-cleanup-setting-hint' }, t(hintKey)) : null,
        ),
        h('div', { className: 'dsh-cleanup-setting-control' },
          h('input', {
            id: props.inputId,
            className: 'dsh-cleanup-check',
            type: 'checkbox',
            checked: props.checked === true,
            disabled: props.disabled === true,
            'aria-labelledby': props.inputId + '-label',
            onChange: function (event) { props.onChange(event.target.checked) },
          }),
        ),
      )
    }

    /** «最近删除» + last-startup line from `inventory.audit` (P1 item 4). */
    function AuditSection(props) {
      const t = props.t
      const audit = props.audit
      const catalog = props.catalog
      const workspaceLabels = props.workspaceLabels
      if (!audit || typeof audit !== 'object') return null
      const startup = audit.lastStartup
      const rows = Array.isArray(audit.recent) ? audit.recent.slice(0, AUDIT_RECENT_MAX) : []
      const children = [
        h('div', { className: 'dsh-cleanup-section-title', key: 'title' }, t('audit.title')),
      ]
      if (startup) {
        children.push(h('div', { className: 'dsh-cleanup-muted', key: 'startup' }, t('audit.lastStartup', {
          time: formatTime(startup.at) || t('common.none'),
          applied: formatNumber(startup.applied),
          skipped: formatNumber(startup.skipped),
          failed: formatNumber(startup.failed),
        })))
      }
      if (rows.length === 0) {
        children.push(h('div', { className: 'dsh-cleanup-empty', key: 'empty' }, t('audit.empty')))
      } else {
        children.push(h('ul', { className: 'dsh-cleanup-list', key: 'rows' }, rows.map(function (record, index) {
          const actionText = auditActionText(t, record.action)
          const statusText = auditStatusText(t, record.status)
          const tone = record.status === 'failed'
            ? 'error'
            : (record.status === 'skipped' ? 'warn' : (record.status === 'deleted' || record.status === 'trashed' ? 'success' : 'idle'))
          const codeText = typeof record.code === 'string' && record.code !== ''
            ? (hasKey('error.' + record.code) ? t('error.' + record.code) : record.code)
            : null
          const targetsText = auditTargetsLabel(t, catalog, workspaceLabels, record.targets, DEFERRED_TARGETS_MAX)
          const metaChildren = [
            h('span', { key: 'time' }, formatTime(record.at) || t('common.none')),
            h(Sep, { key: 'sep-source' }),
            h('span', { key: 'source' }, t(record.source === 'startup' ? 'audit.source.startup' : 'audit.source.immediate')),
          ]
          if (record.mode) {
            metaChildren.push(h(Sep, { key: 'sep-mode' }))
            metaChildren.push(h('span', { key: 'mode' }, deferredModeText(t, record.mode)))
          }
          if (record.bytes > 0) {
            metaChildren.push(h(Sep, { key: 'sep-bytes' }))
            metaChildren.push(h('span', { className: 'dsh-cleanup-size', key: 'bytes' }, formatBytes(record.bytes)))
          }
          if (targetsText !== '') {
            metaChildren.push(h(Sep, { key: 'sep-targets' }))
            metaChildren.push(h('span', { key: 'targets', title: targetsText }, middleEllipsis(targetsText, 80)))
          }
          return h('li', { className: 'dsh-cleanup-item', key: 'audit-' + index },
            h('div', { className: 'dsh-cleanup-item-main' },
              h('div', { className: 'dsh-cleanup-item-head' },
                h('span', { className: 'dsh-cleanup-item-title' }, actionText),
                h(Badge, { tone: tone }, statusText),
                codeText !== null ? h('span', { className: 'dsh-cleanup-muted' }, codeText) : null,
              ),
              h('div', { className: 'dsh-cleanup-item-meta' }, metaChildren),
            ),
          )
        })))
      }
      return h('div', { className: 'dsh-cleanup-group' }, children)
    }

    /**
     * Fourth storage tab: cleanup settings form (P1 item 1) plus the audit section
     * (item 4). Values are edited as an independent draft; only changed fields are sent,
     * client-side bounds mirror SPEC §4.8, and a Host field error lands on its control.
     */
    function SettingsPanel(props) {
      const t = props.t
      const state = props.state
      const store = props.store
      const catalog = props.catalog
      const ids = useId()
      const settings = state.settings || null
      const form = state.settingsForm || null
      const fieldErrors = state.settingsFieldErrors && typeof state.settingsFieldErrors === 'object' ? state.settingsFieldErrors : {}
      const busy = state.settingsSaving === true
      const defaults = state.settingsDefaults && typeof state.settingsDefaults === 'object'
        ? state.settingsDefaults
        : null
      const hasDefaults = defaults !== null && Object.keys(defaults).length > 0
      const inventory = state.inventory
      const audit = inventory && inventory.audit ? inventory.audit : null
      const workspaceLabels = deferredWorkspaceLabels(inventory)

      if (!settings || !form) {
        if (state.settingsError && state.settingsErrorSource !== 'save') {
          return h('div', { className: 'dsh-cleanup-panel' },
            renderErrorBlock(t, state.settingsError, function () { store.retrySettings() }))
        }
        return h('div', { className: 'dsh-cleanup-panel', 'aria-busy': 'true' },
          h('div', { className: 'dsh-cleanup-sr' }, t('page.loading')),
          h(Skeleton, { lines: 4 }),
        )
      }

      let dirty = false
      try { dirty = settingsFormHasChanges(t, form, settings) } catch (error) { dirty = false }

      function fieldInputId(field) {
        return ids + '-field-' + field
      }

      function numberRow(field) {
        const bounds = settingsFieldBoundsForDisplay(field) || { min: 0 }
        return h(SettingsNumberRow, {
          key: field,
          t: t,
          field: field,
          inputId: fieldInputId(field),
          value: typeof form[field] === 'string' ? form[field] : String(form[field] === undefined ? '' : form[field]),
          min: bounds.min,
          max: bounds.max,
          step: 1,
          disabled: busy,
          error: fieldErrors[field] || null,
          onChange: function (value) { store.setSettingsField(field, value) },
        })
      }

      function toggleRow(field) {
        return h(SettingsToggleRow, {
          key: field,
          t: t,
          field: field,
          inputId: fieldInputId(field),
          checked: form[field] === true,
          disabled: busy,
          onChange: function (value) { store.setSettingsBoolean(field, value) },
        })
      }

      const statusChildren = []
      const status = state.settingsStatus
      if (status && status.kind === 'saved') {
        const statusText = status.persisted === false
          ? t('settings.savedVolatile')
          : t('settings.saved')
        statusChildren.push(h('span', { key: 'saved', className: status.persisted === false ? 'dsh-cleanup-status-warn' : 'dsh-cleanup-status-success' }, statusText))
        if (status.persisted === false && status.persistError && typeof status.persistError.message === 'string' && status.persistError.message !== '') {
          statusChildren.push(h('span', { key: 'detail', className: 'dsh-cleanup-muted' },
            t('settings.persistError', { message: status.persistError.message })))
        }
        if (Array.isArray(status.warnings) && status.warnings.length > 0) {
          statusChildren.push(h('span', { key: 'warnings', className: 'dsh-cleanup-muted' },
            status.warnings.map(function (warning) {
              return warning && typeof warning.message === 'string' ? warning.message : ''
            }).filter(function (message) { return message !== '' }).join(' · ')))
        }
      } else if (status && status.kind === 'unchanged') {
        statusChildren.push(h('span', { key: 'unchanged', className: 'dsh-cleanup-muted' }, t('settings.unchanged')))
      } else if (status && status.kind === 'reset') {
        statusChildren.push(h('span', { key: 'reset', className: 'dsh-cleanup-muted' }, t('settings.resetHint')))
      } else if (state.settingsSaving === true) {
        statusChildren.push(h('span', { key: 'saving', className: 'dsh-cleanup-muted' }, t('settings.saving')))
      } else if (dirty) {
        statusChildren.push(h('span', { key: 'dirty', className: 'dsh-cleanup-muted' }, t('settings.resetHint')))
      }
      const statusLine = h('div', {
        className: 'dsh-cleanup-deferred-lastrun',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }, statusChildren)

      const notWritableNotice = state.settingsPersisted === false
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-warn', role: 'status' },
          h('span', { className: 'dsh-cleanup-banner-text' }, t('settings.notWritable')))
        : null
      const saveError = state.settingsError && state.settingsErrorSource === 'save'
        ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-error', role: 'alert' },
          h('span', { className: 'dsh-cleanup-banner-text' }, apiErrorText(t, state.settingsError)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
            onClick: function () { store.retrySettings() },
          }, t('action.retry')))
        : null

      const settingsValue = settings || {}
      const trashRoot = typeof settingsValue.trashRoot === 'string' && settingsValue.trashRoot !== ''
        ? settingsValue.trashRoot
        : (inventory && typeof inventory.dshHome === 'string' ? inventory.dshHome + '/trash/dsh-cleanup' : t('common.none'))

      return h('div', { className: 'dsh-cleanup-settings' },
        statusLine,
        notWritableNotice,
        saveError,
        h('div', { className: 'dsh-cleanup-group' },
          h('div', { className: 'dsh-cleanup-section-title' }, t('settings.group.deletion')),
          toggleRow('allowPermanentDeletion'),
        ),
        h('div', { className: 'dsh-cleanup-group' },
          h('div', { className: 'dsh-cleanup-section-title' }, t('settings.group.trash')),
          numberRow('trashRetentionDays'),
          numberRow('trashMaxBytes'),
          h('div', { className: 'dsh-cleanup-setting', key: 'trashRoot' },
            h('div', { className: 'dsh-cleanup-setting-main' },
              h('span', { className: 'dsh-cleanup-setting-label' }, t('settings.field.trashRoot')),
              h('div', { className: 'dsh-cleanup-setting-hint' }, t('settings.field.trashRootHint')),
              h('div', { className: 'dsh-cleanup-path', title: trashRoot }, middleEllipsis(trashRoot, 72)),
            ),
            h('span', { className: 'dsh-cleanup-badge dsh-cleanup-badge-idle' }, t('settings.field.notEditable')),
          ),
        ),
        h('div', { className: 'dsh-cleanup-group' },
          h('div', { className: 'dsh-cleanup-section-title' }, t('settings.group.audit')),
          toggleRow('auditEnabled'),
          numberRow('auditMaxBytes'),
        ),
        h('div', { className: 'dsh-cleanup-group' },
          h('div', { className: 'dsh-cleanup-section-title' }, t('settings.group.advanced')),
          SETTINGS_ADVANCED_FIELDS.map(function (field) { return numberRow(field) }),
          toggleRow('gitSafetyCheck'),
        ),
        h('div', { className: 'dsh-cleanup-toolbar' },
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-accent',
            disabled: busy,
            onClick: function () { store.saveSettings() },
          }, busy ? t('settings.saving') : t('settings.save')),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn',
            disabled: busy || !hasDefaults,
            onClick: function () { store.resetSettings() },
          }, t('settings.reset')),
        ),
        h(AuditSection, { t: t, audit: audit, catalog: catalog, workspaceLabels: workspaceLabels }),
      )
    }

    function CleanupPage(props) {
      const api = props.api
      const t = props.t || (api && api.t)
      const storeRef = useRef(null)
      if (storeRef.current === null && api) storeRef.current = api.createPageStore()
      const store = storeRef.current || FALLBACK_PAGE_STORE
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const catalogApi = (api && api.catalog) || FALLBACK_CATALOG
      const catalog = useSyncExternalStore(catalogApi.subscribe, catalogApi.getSnapshot)
      const ids = useId()
      const tablistRef = useRef(null)
      const pageTitleRef = useRef(null)
      const deferredToggleRef = useRef(null)
      const retainedHeadingRef = useRef(null)
      const pageRef = useRef(null)

      useEffect(function () {
        if (!storeRef.current) return undefined
        store.loadInventory()
        return function () { store.dispose() }
      }, [store])

      // F4: after a successful cancel the clicked control (or the whole banner) may
      // unmount under the focused element. The store records where focus should land
      // from the queue size the action left; both targets are persistent page-level
      // controls (the banner's Show/Hide toggle, else the page title).
      useEffect(function () {
        const request = state.deferredFocusRequest
        if (!request) return
        const toggle = deferredToggleRef.current
        const target = request.target === 'toggle' && toggle && toggle.isConnected !== false
          ? toggle
          : pageTitleRef.current
        if (target && typeof target.focus === 'function') {
          try { target.focus({ preventScroll: true }) } catch (error) { /* focus is best effort */ }
        }
        store.clearDeferredFocusRequest()
      }, [state.deferredFocusRequest, store])

      // Retained-row focus handoff (same contract as the deferred-cancel one):
      // the removed row's successor action, else the «上次未完成» heading, else the
      // banner toggle, else the page heading. The request is set after the reload
      // that removes the row, so this effect runs against the new DOM.
      useEffect(function () {
        const request = state.retainedFocusRequest
        if (!request) return
        let target = null
        if (request.nextEntryId && pageRef.current) {
          const rows = pageRef.current.querySelectorAll('[data-dsh-cleanup-retained-row]')
          for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].getAttribute('data-dsh-cleanup-retained-row') !== request.nextEntryId) continue
            const action = rows[i].querySelector('[data-dsh-cleanup-retained-action]')
            if (action) target = action
            break
          }
        }
        if (!target) {
          const heading = retainedHeadingRef.current
          if (heading && heading.isConnected !== false && typeof heading.focus === 'function') target = heading
        }
        if (!target) {
          const toggle = deferredToggleRef.current
          if (toggle && toggle.isConnected !== false && typeof toggle.focus === 'function') target = toggle
        }
        if (!target) target = pageTitleRef.current
        if (target && typeof target.focus === 'function') {
          try { target.focus({ preventScroll: true }) } catch (error) { /* focus is best effort */ }
        }
        store.clearRetainedFocusRequest()
      }, [state.retainedFocusRequest, store])

      useEffect(function () {
        if (!api || !storeRef.current) return undefined
        return api.mutations.subscribe(function () { store.refresh() })
      }, [api, store])

      const tabNames = ['workspaces', 'sessions', 'trash', 'settings']
      const inventory = state.inventory
      let unmeasured = 0
      if (inventory !== null && (state.tab === 'workspaces' || state.tab === 'sessions')) {
        if (state.tab === 'sessions') {
          const sessions = Array.isArray(inventory.sessions) ? inventory.sessions : []
          for (let i = 0; i < sessions.length; i += 1) {
            const session = sessions[i]
            const measured = state.measured.sessions[session.id]
            if (!(measured && typeof measured.bytes === 'number') && typeof session.sizeBytes !== 'number') unmeasured += 1
          }
        } else {
          const workspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : []
          for (let i = 0; i < workspaces.length; i += 1) {
            const row = workspaces[i]
            const measured = state.measured.workspaces[row.id]
            if (!(measured && typeof measured.bytes === 'number')) unmeasured += 1
          }
        }
      }

      function focusTab(name) {
        const list = tablistRef.current
        if (!list) return
        const button = list.querySelector('[data-dsh-cleanup-tab="' + name + '"]')
        if (button && typeof button.focus === 'function') button.focus()
      }

      function onTabKeyDown(event) {
        const current = tabNames.indexOf(state.tab)
        if (current < 0) return
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          const next = tabNames[(current + 1) % tabNames.length]
          store.setTab(next)
          focusTab(next)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = tabNames[(current + tabNames.length - 1) % tabNames.length]
          store.setTab(next)
          focusTab(next)
        } else if (event.key === 'Home') {
          event.preventDefault()
          store.setTab(tabNames[0])
          focusTab(tabNames[0])
        } else if (event.key === 'End') {
          event.preventDefault()
          store.setTab(tabNames[tabNames.length - 1])
          focusTab(tabNames[tabNames.length - 1])
        }
      }

      function openDialogFor(targets) {
        if (!api) return
        // Open the review inside this settings page (the sheet-hosted CleanupDialog rendered
        // below). `shell.overlay` is painted at z-index 20 inside the app frame while the
        // settings sheet is a fixed layer at z-index 1000, so an overlay dialog can only be
        // seen by closing the sheet — which used to throw away the user's place in it.
        api.openDialog(targets, { surface: 'settings' })
      }

      function onDelete(targets) {
        openDialogFor(targets)
      }

      const tabs = tabNames.map(function (name) {
        return h('button', {
          key: name,
          type: 'button',
          role: 'tab',
          id: ids + '-tab-' + name,
          'aria-selected': state.tab === name ? 'true' : 'false',
          'aria-controls': ids + '-panel',
          tabIndex: state.tab === name ? 0 : -1,
          className: 'dsh-cleanup-tab',
          'data-dsh-cleanup-tab': name,
          onClick: function () { store.setTab(name) },
        }, t('tab.' + name))
      })

      let panelContent
      if (state.tab === 'workspaces') {
        panelContent = h(WorkspacesPanel, { t: t, state: state, store: store, onDelete: onDelete })
      } else if (state.tab === 'sessions') {
        panelContent = h(SessionsPanel, { t: t, state: state, store: store, onDelete: onDelete, catalog: catalog })
      } else if (state.tab === 'trash') {
        panelContent = h(TrashPanel, { t: t, state: state, store: store })
      } else {
        panelContent = h(SettingsPanel, { t: t, state: state, store: store, catalog: catalog })
      }

      const banners = []
      if (inventory && state.inventoryError) {
        banners.push(h('div', { key: 'inventory-error', className: 'dsh-cleanup-banner dsh-cleanup-banner-error', role: 'alert' },
          h('span', { className: 'dsh-cleanup-banner-text' }, apiErrorText(t, state.inventoryError)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
            onClick: function () { store.loadInventory() },
          }, t('action.retry')),
        ))
      }
      if (state.measureError) {
        banners.push(h('div', { key: 'measure-error', className: 'dsh-cleanup-banner dsh-cleanup-banner-error', role: 'alert' },
          h('span', { className: 'dsh-cleanup-banner-text' }, apiErrorText(t, state.measureError)),
          h('button', {
            type: 'button',
            className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
            onClick: function () { store.measureUnmeasured() },
          }, t('action.retry')),
        ))
      }

      // F4: the armed/cancelled announcements live at page level so they survive the
      // banner (and its status region) being removed after the last entry is cancelled.
      const deferredConfirmValue = state.deferredConfirm === undefined ? null : state.deferredConfirm
      const deferredArmedText = deferredConfirmValue === 'all'
        ? t('deferred.cancelAllArmed')
        : (deferredConfirmValue !== null ? t('deferred.cancelArmed') : '')
      const deferredNoticeState = state.deferredNotice
      const deferredAnnounceText = deferredNoticeState && typeof deferredNoticeState.cancelled === 'number' && deferredNoticeState.cancelled > 0
        ? plural(t, 'deferred.cancelled', deferredNoticeState.cancelled)
        : ''
      const deferredArmedKey = 'deferred-armed-' + (deferredConfirmValue === null ? 'none' : String(deferredConfirmValue))
      const deferredNoticeKey = 'deferred-notice-' + (deferredNoticeState ? String(deferredNoticeState.seq) : 'none')
      const retainedNoticeState = state.retainedNotice
      const retainedAnnounceText = retainedNoticeState && typeof retainedNoticeState.count === 'number' && retainedNoticeState.count > 0
        ? plural(t, retainedNoticeState.kind === 'requeue' ? 'deferred.retained.requeued' : 'deferred.retained.forgotten', retainedNoticeState.count)
        : ''
      const retainedNoticeKey = 'retained-notice-' + (retainedNoticeState ? String(retainedNoticeState.seq) : 'none')
      const retainedConfirmState = state.retainedConfirm
      const retainedArmedText = retainedConfirmState && retainedConfirmState.action
        ? t(retainedConfirmState.action === 'requeue' ? 'deferred.retained.requeueArmed' : 'deferred.retained.forgetArmed')
        : ''
      const retainedArmedKey = 'retained-armed-' + (retainedConfirmState ? String(retainedConfirmState.action) + ':' + String(retainedConfirmState.id) : 'none')
      // P1 item 4: one-time notice for a startup run that is recent and not acknowledged.
      const startupNotice = inventory ? auditStartupNoticeVisible(inventory.audit) : null
      const showStartupNotice = startupNotice !== null && state.auditNoticeAck !== startupNotice.at

      const page = h('section', { className: 'dsh-cleanup-page', 'aria-label': t('page.title'), ref: pageRef },
        // An array keeps the keys meaningful, so repeating the same announcement
        // remounts the region and is spoken again by screen readers.
        h('div', { key: 'deferred-live-regions' }, [
          h('div', { key: deferredArmedKey, className: 'dsh-cleanup-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, deferredArmedText),
          h('div', { key: deferredNoticeKey, className: 'dsh-cleanup-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, deferredAnnounceText),
          h('div', { key: retainedArmedKey, className: 'dsh-cleanup-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, retainedArmedText),
          h('div', { key: retainedNoticeKey, className: 'dsh-cleanup-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, retainedAnnounceText),
        ]),
        h('header', { className: 'dsh-cleanup-page-head' },
          h('div', { className: 'dsh-cleanup-page-heading' },
            h('h2', { className: 'dsh-cleanup-page-title', ref: pageTitleRef, tabIndex: -1 }, t('page.title')),
            h('p', { className: 'dsh-cleanup-page-intro' }, t('page.intro')),
          ),
          h('div', { className: 'dsh-cleanup-page-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-cleanup-btn dsh-cleanup-btn-ghost',
              disabled: state.inventoryLoading,
              onClick: function () { store.refresh() },
            }, t('page.refresh')),
            unmeasured > 0
              ? h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn',
                disabled: state.measuring || state.inventoryLoading,
                onClick: function () { store.measureUnmeasured() },
              }, state.measuring ? t('measure.measuring') : t('page.measure'))
              : null,
          ),
        ),
        showStartupNotice
          ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-warn dsh-cleanup-deferred-banner', key: 'startup-notice' },
            h('span', { className: 'dsh-cleanup-banner-text' },
              h('strong', { style: { display: 'block' } }, t('audit.notice.title')),
              h('span', null, t('audit.notice.body', {
                applied: formatNumber(startupNotice.applied),
                skipped: formatNumber(startupNotice.skipped),
                failed: formatNumber(startupNotice.failed),
              })),
            ),
            h('div', { className: 'dsh-cleanup-item-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                onClick: function () { store.setTab('settings') },
              }, t('audit.notice.link')),
              h('button', {
                type: 'button',
                className: 'dsh-cleanup-btn dsh-cleanup-btn-sm',
                onClick: function () { store.dismissAuditNotice(startupNotice.at) },
              }, t('audit.notice.dismiss')),
            ),
          )
          : null,
        inventory && inventory.truncated
          ? h('div', { className: 'dsh-cleanup-banner dsh-cleanup-banner-warn', role: 'status' },
            h('span', { className: 'dsh-cleanup-banner-text' },
              typeof inventory.sessionListCap === 'number'
                ? t('page.truncated.cap', { count: formatNumber(inventory.sessionListCap) })
                : t('page.truncated')))
          : null,
        banners.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, banners) : null,
        inventory && inventory.deferred
          ? h(DeferredBanner, {
            t: t,
            state: state,
            store: store,
            catalog: catalog,
            toggleRef: deferredToggleRef,
            retainedHeadingRef: retainedHeadingRef,
          })
          : null,
        h('div', { className: 'dsh-cleanup-tabs', role: 'tablist', ref: tablistRef, onKeyDown: onTabKeyDown }, tabs),
        h('div', {
          className: 'dsh-cleanup-panel',
          role: 'tabpanel',
          id: ids + '-panel',
          'aria-labelledby': ids + '-tab-' + state.tab,
        }, panelContent),
        h('footer', { className: 'dsh-cleanup-page-foot' }, t('page.footer.note')),
      )

      // The sheet-hosted review: painted above the sheet's own panel instead of behind it,
      // so dismissing the review returns to the same tab with the sheet still open.
      return h(React.Fragment, null,
        page,
        h(CleanupDialog, { api: api, t: t, surface: 'settings' }),
      )
    }

    // ---------------------------------------------------- context-menu glyph

    /** 16px trash glyph rendered with `currentColor` (SPEC §7 item 4). */
    function CleanupTrashGlyph() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M2.75 4.5h10.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M6 2.75h4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', {
          d: 'M4.1 4.5l.55 8.05a1.3 1.3 0 0 0 1.3 1.2h4.1a1.3 1.3 0 0 0 1.3-1.2l.55-8.05',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M6.6 6.9v4.3M9.4 6.9v4.3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    // ---------------------------------------------------------------- startup

    // ------------------------------------------------------- locale registration

    /**
     * Register the plugin dictionaries and bind the translator, then keep the module-level
     * active-locale id in sync so `plural()` can select locale-specific categories
     * (one/few/many/other). Baseline DSH locales are zh/en; a language pack that registers
     * another id automatically gets correct plurals once its dictionary is in
     * EXTRA_LOCALE_DICTIONARIES. Returns the bound translator, or null when the shared
     * locale service is missing (the whole UI must stay inactive then — SPEC §7).
     * @param {object} ctx - client plugin context.
     * @param {object} locale - the shared locale runtime (`ctx.locale`).
     * @returns {Function | null} bound `t`.
     */
    function registerLocale(ctx, locale) {
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return null
      const dictionaries = Object.assign({}, { zh: zh, en: en }, EXTRA_LOCALE_DICTIONARIES)
      registeredDictionarySet = dictionaries
      ctx.effect(function () {
        return locale.register(NS, dictionaries)
      }, 'dsh-cleanup: dictionaries')
      const t = locale.bind(NS)
      setActiveLocaleId(readActiveLocaleId(locale))
      if (typeof locale.subscribe === 'function') {
        ctx.effect(function () {
          return locale.subscribe(function () {
            setActiveLocaleId(readActiveLocaleId(locale))
          })
        }, 'dsh-cleanup: locale subscription')
      }
      if (typeof ctx.on === 'function') {
        ctx.effect(function () {
          return ctx.on('locale/change', function (snapshot) {
            const id = readLocaleIdFromSnapshot(snapshot)
            if (id !== null) setActiveLocaleId(id)
          })
        }, 'dsh-cleanup: locale change')
      }
      return t
    }


    // ------------------------------------------------------- single-file layout
    //
    // The browser module loader loads exactly one module per package and this bundle
    // has no build step, so client.js is intentionally one file. To keep that file
    // maintainable it is split into the focused factories below; `apply` at the end
    // only wires them together. Everything in this factory scope is shared by every
    // mount of the plugin in the page.

    /**
     * Mutation fan-out shared by the dialog and the settings page: a successful
     * destructive action refreshes mounted settings pages and the session catalog.
     * @returns {{ subscribe: (listener: Function) => Function, bump: () => void }}
     */
    function createMutationEmitter() {
      const mutationListeners = new Set()
      const mutationEmitter = {
        subscribe: function (listener) {
          mutationListeners.add(listener)
          return function () { mutationListeners.delete(listener) }
        },
        bump: function () {
          Array.from(mutationListeners).forEach(function (listener) {
            try { listener() } catch (error) { /* ignore */ }
          })
        },
      }

      return mutationEmitter
    }

    /**
     * Best-effort post-mutation refresh: re-list the Host-authoritative session catalog
     * (so the sidebar and this UI agree) and wake every mounted settings page.
     * @param {object} ctx - client plugin context.
     * @param {object} mutations - emitter from `createMutationEmitter`.
     * @returns {Function} notifyMutation.
     */
    function createMutationNotifier(ctx, mutations) {
      return function notifyMutation() {
        try {
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.refresh === 'function') {
            const pending = sessions.refresh()
            if (pending && typeof pending.catch === 'function') pending.catch(function () { })
          }
        } catch (error) { /* refresh is best effort */ }
        mutations.bump()
      }
    }

    /**
     * Live bridge to the optional session catalog (`ctx.sessions.list`), the same
     * authority the sidebar renders. Absent service degrades to the label fallbacks.
     * @param {object} ctx - client plugin context.
     * @returns {{ getSnapshot: Function, subscribe: Function, dispose: Function }}
     */
    function createSessionCatalogBridge(ctx) {
      // Live bridge to the optional session catalog (`ctx.sessions.list`).
      // The catalog is the same authority the sidebar shows: durable title →
      // project basename → session id. Absent service degrades to fallbacks.
      const catalogListeners = new Set()
      let catalogList = null
      let catalogSnapshot = null
      let catalogUnsubscribe = null

      function readCatalogSnapshot(list) {
        try {
          const snapshot = list.getSnapshot()
          return snapshot && typeof snapshot === 'object' ? snapshot : null
        } catch (error) {
          return null
        }
      }

      function ensureCatalog() {
        if (catalogList !== null) return catalogList
        let service
        try {
          service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        } catch (error) {
          service = undefined
        }
        const list = service && service.list
        if (!list || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
        catalogList = list
        catalogSnapshot = readCatalogSnapshot(list)
        try {
          catalogUnsubscribe = list.subscribe(function () {
            catalogSnapshot = readCatalogSnapshot(list)
            Array.from(catalogListeners).forEach(function (listener) {
              try { listener() } catch (error) { /* a broken subscriber must not break the bridge */ }
            })
          })
        } catch (error) {
          catalogUnsubscribe = null
        }
        return catalogList
      }

      function catalogGetSnapshot() {
        if (catalogList === null) ensureCatalog()
        return catalogSnapshot
      }

      function catalogSubscribe(listener) {
        catalogListeners.add(listener)
        ensureCatalog()
        return function () { catalogListeners.delete(listener) }
      }

      ensureCatalog()

      return {
        getSnapshot: catalogGetSnapshot,
        subscribe: catalogSubscribe,
        dispose: function () {
          if (catalogUnsubscribe !== null) {
            try { catalogUnsubscribe() } catch (error) { /* ignore */ }
            catalogUnsubscribe = null
          }
          catalogList = null
          catalogSnapshot = null
          catalogListeners.clear()
        },
      }
    }

    /**
     * Review-dialog controller (SPEC §9): one immutable store plus the plan/delete/defer
     * transitions, focus restore, timer and fetch aborts. `apply` owns only its lifetime.
     * @param {{ ctx: object, mutations: object, notifyMutation: Function }} deps - wiring.
     * @returns {object} `store` and the dialog actions.
     */
    function createDialogController(deps) {
      const ctx = deps.ctx
      const mutations = deps.mutations
      const notifyMutation = deps.notifyMutation
      const dialogStore = createStore(initialDialogState())
      let dialogAbort = null
      let dialogToken = 0
      let doneTimer = null
      let returnFocus = null

      function clearDoneTimer() {
        if (doneTimer !== null) {
          clearTimeout(doneTimer)
          doneTimer = null
        }
      }

      function abortDialogFetch() {
        dialogToken += 1
        if (dialogAbort !== null) {
          try { dialogAbort.abort() } catch (error) { /* ignore */ }
          dialogAbort = null
        }
      }

      function beginDialogFetch() {
        abortDialogFetch()
        const controller = new AbortController()
        dialogAbort = controller
        return { controller: controller, token: dialogToken }
      }

      function settleDialogFetch(handle) {
        if (handle.token !== dialogToken) return false
        if (dialogAbort === handle.controller) dialogAbort = null
        return true
      }


      /** The checked subset of the reviewed targets. An empty selection means "nothing to plan". */
      function plannedTargets(state) {
        const selected = {}
        for (let i = 0; i < state.selection.length; i += 1) selected[state.selection[i]] = true
        return state.targets.filter(function (target) { return selected[targetKey(target)] === true })
      }

      /**
       * True when the plan brings back a reviewed row the user un-checked. The Host expands every
       * checked Session into its subagent closure, and a workspace target sweeps the Sessions
       * inside its folder, so either can smuggle an explicitly removed row back in. The checkbox is
       * authoritative: the first fallback drops descendant expansion, and a plan that still leaks
       * is refused instead of deleting an un-checked target (SPEC §9).
       */
      function planLeaksUncheckedTargets(plan, state) {
        const checked = {}
        for (let i = 0; i < state.selection.length; i += 1) checked[state.selection[i]] = true
        const items = plan && Array.isArray(plan.items) ? plan.items : []
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          if (!item || item.kind !== 'session' || typeof item.id !== 'string') continue
          const key = 'session:' + item.id
          if (checked[key] === true) continue
          for (let j = 0; j < state.targets.length; j += 1) {
            if (targetKey(state.targets[j]) === key) return true
          }
        }
        return false
      }

      /** Count workspace targets in the checked subset. */
      function plannedWorkspaceTargets(planned) {
        let count = 0
        for (let i = 0; i < planned.length; i += 1) {
          if (planned[i] && planned[i].kind === 'workspace') count += 1
        }
        return count
      }

      function startPlan() {
        const state = dialogStore.getSnapshot()
        if (state.phase === 'idle' || state.targets.length === 0) return
        const planned = plannedTargets(state)
        if (planned.length === 0) {
          // Every row is un-checked: drop the stale plan so the review renders the empty selection
          // (with its "select at least one" hint) instead of numbers for targets the user removed.
          dialogStore.setState({ plan: null, refreshing: false, error: null, failureStage: null })
          return
        }
        if (state.mode === 'permanent' && plannedWorkspaceTargets(planned) > 1) {
          // The Host refuses a permanent plan over several directories. The selection can grow after
          // the user narrowed it, so re-validate the real planned set here and fall back to trash
          // with an explanation instead of sending a plan that can only fail (SPEC §9).
          dialogStore.setState({ mode: 'trash', typed: '', modeNotice: true })
          startPlan()
          return
        }
        const handle = beginDialogFetch()
        const hasPlan = state.plan !== null && state.plan !== undefined
        dialogStore.setState({
          phase: hasPlan ? 'review' : 'planning',
          refreshing: hasPlan,
          error: null,
          failureStage: null,
        })
        const body = {
          targets: planned.map(function (target) { return { kind: target.kind, id: target.id } }),
          mode: state.mode,
          includeSessions: state.includeSessions === true,
          includeDescendants: state.includeDescendants === true,
        }
        request(ROUTE.plan, body, handle.controller.signal).then(function (envelope) {
          if (!settleDialogFetch(handle)) return
          if (envelope.transport) {
            dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'plan', error: { transport: envelope.transport } })
            return
          }
          if (envelope.ok !== true) {
            dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'plan', error: toApiError(envelope) })
            return
          }
          const plan = envelope.plan
          if (!isPlan(plan)) {
            dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'plan', error: { transport: 'badResponse' } })
            return
          }
          if (planLeaksUncheckedTargets(plan, state)) {
            if (state.includeDescendants === true) {
              // Drop descendant expansion and plan again: the un-checked row must stay on disk.
              dialogStore.setState({ includeDescendants: false, descendantsAutoOff: true })
              startPlan()
              return
            }
            // Even without descendants the Host's plan still contains a target the user removed
            // (for example a folder sweep). Refuse to delete it: fail closed instead of ignoring the
            // checkbox (SPEC §9).
            dialogStore.setState({
              phase: 'failed',
              refreshing: false,
              failureStage: 'plan',
              error: { code: 'UNCHECKED_TARGET_LEAK' },
            })
            return
          }
          dialogStore.setState({
            phase: 'review',
            refreshing: false,
            failureStage: null,
            error: null,
            plan: plan,
            mode: plan.mode === 'permanent' ? 'permanent' : 'trash',
            typed: '',
          })
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (!settleDialogFetch(handle)) return
          dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'plan', error: { transport: 'network' } })
        })
      }

      function openDialog(rawTargets, options) {
        const targets = normalizeTargets(rawTargets)
        if (targets.length === 0) return
        // A workspace clear owns the dialog until it settles, and no review may replace one whose
        // delete/queue request is on the wire: closing it would abort the request and drop its result
        // (SPEC §9).
        const current = dialogStore.getSnapshot()
        if (current.clear !== null && current.phase !== 'idle') return
        if (current.phase === 'deleting' || current.phase === 'deferring') return
        const surface = options && options.surface === 'settings' ? 'settings' : 'overlay'
        const active = typeof document !== 'undefined' ? document.activeElement : null
        const activeIsBody = typeof document !== 'undefined' && active === document.body
        returnFocus = active && !activeIsBody && typeof active.focus === 'function' ? active : null
        clearDoneTimer()
        abortDialogFetch()
        dialogStore.setState(Object.assign(initialDialogState(), {
          phase: 'planning',
          targets: targets,
          surface: surface,
          selection: targets.map(targetKey),
        }))
        startPlan()
      }

      // ------------------------------------------------ workspace session clear

      /** Fresh bookkeeping for one "清空工作区会话…" run (SPEC §7 item 5). */
      function initialClearState(workspace) {
        return {
          workspaceId: workspace.id,
          title: typeof workspace.title === 'string' ? workspace.title : '',
          /** Session logs matched by the pre-flight; the Host `total` counts before `limit`. */
          total: 0,
          deletable: 0,
          skipped: 0,
          /** `kind:id` keys already counted in `skipped`; a refilled page may repeat them. */
          skippedKeys: {},
          /** `UNKNOWN_SESSION` queue rebuilds already attempted for this clear. */
          resyncs: 0,
          /** `kind:id` keys the user un-checked; they must never reappear in a later batch. */
          excluded: {},
          /** Targets waiting for their own batch; the batch in flight lives in `targets`. */
          queued: [],
          /** The last candidates page was cut by the Host limit, so drain it and refill. */
          truncated: false,
          rounds: 0,
          batches: 0,
          done: { count: 0, bytes: 0, failed: 0 },
          stop: null,
        }
      }

      /**
       * One candidates page → deletable Session targets. `deletable: false` rows (live or running
       * in this app run) are counted instead of queued: a plan holding them could never execute.
       */
      function clearTargetsFrom(rows, excluded) {
        const targets = []
        const skippedTargets = []
        let skipped = 0
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (!row || typeof row.id !== 'string' || row.id === '') continue
          const target = { kind: 'session', id: row.id }
          if (typeof row.cwd === 'string' && row.cwd !== '') target.cwd = row.cwd
          if (row.deletable !== true) {
            skipped += 1
            skippedTargets.push(target)
            continue
          }
          // A row the user un-checked earlier must never be swept up by a later page.
          if (excluded && excluded[targetKey(target)] === true) continue
          targets.push(target)
        }
        return { targets: targets, skipped: skipped, skippedTargets: skippedTargets }
      }

      /**
       * Fold one candidates page's in-use rows into the clear's running count without double
       * counting: the same live Session reappears on every refilled page until the app restarts
       * (SPEC §9).
       * @param {object} clear - current clear bookkeeping.
       * @param {object[]} skippedTargets - rows this page reported as not deletable.
       * @returns {{ skipped: number, skippedKeys: Record<string, boolean>, added: number }}
       */
      function absorbSkipped(clear, skippedTargets) {
        const keys = Object.assign({}, clear && clear.skippedKeys && typeof clear.skippedKeys === 'object' ? clear.skippedKeys : {})
        let added = 0
        for (let i = 0; i < skippedTargets.length; i += 1) {
          const key = targetKey(skippedTargets[i])
          if (keys[key] === true) continue
          keys[key] = true
          added += 1
        }
        const previous = typeof clear?.skipped === 'number' ? clear.skipped : 0
        return { skipped: previous + added, skippedKeys: keys, added: added }
      }

      /**
       * True when every skipped row waits only on this app run (an open or running Session). Those
       * rows cannot be deleted now but can be queued for the next start, so the clear offers that
       * route instead of a dead end.
       */
      function skippedRowsWaitForRestart(rows) {
        let seen = 0
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (!row || row.deletable === true) continue
          seen += 1
          const codes = Array.isArray(row.blockerCodes) ? row.blockerCodes : []
          if (codes.length === 0) return false
          for (let j = 0; j < codes.length; j += 1) {
            if (DEFERRABLE_BLOCKER_CODES[codes[j]] !== true) return false
          }
        }
        return seen > 0
      }

      function clearCandidatesBody(clear) {
        return {
          // Only Session logs: the folder and its registration are untouched.
          filters: { workspaceId: clear.workspaceId, requireDeletable: false },
          sort: 'oldest',
          limit: CLEAR_CANDIDATE_LIMIT,
        }
      }

      /**
       * Context-menu entry "清空工作区会话…": pre-flight the workspace, then open the ordinary
       * review on its first batch. The dialog always opens (an empty or failed pre-flight is shown
       * inside it); the resolved `{ ok, empty?, total? }` only lets the caller answer a malformed
       * menu target with a toast.
       */
      function openWorkspaceClear(workspace) {
        const workspaceId = workspace && typeof workspace.id === 'string' ? workspace.id : ''
        if (workspaceId === '') return Promise.resolve({ ok: false, reason: 'badTarget' })
        // A clear already in progress owns the dialog (its folded totals and queue would be lost if a
        // second context-menu action reset the store mid-walk).
        const running = dialogStore.getSnapshot()
        if (running.clear !== null && running.phase !== 'idle') return Promise.resolve({ ok: false, reason: 'busy' })
        const active = typeof document !== 'undefined' ? document.activeElement : null
        const activeIsBody = typeof document !== 'undefined' && active === document.body
        returnFocus = active && !activeIsBody && typeof active.focus === 'function' ? active : null
        clearDoneTimer()
        abortDialogFetch()
        const clear = initialClearState({ id: workspaceId, title: workspace.title })
        dialogStore.setState(Object.assign(initialDialogState(), {
          phase: 'planning',
          surface: 'overlay',
          clear: clear,
        }))
        return runClearPreflight()
      }

      /**
       * Resolve the workspace's Session logs into the first batch. Nothing here closes the dialog:
       * a workspace that cannot be cleared, or a failed pre-flight, keeps the window and its review
       * so the reason is readable and retryable (SPEC §9).
       */
      function runClearPreflight() {
        const state = dialogStore.getSnapshot()
        const clear = state.clear
        if (clear === null) return Promise.resolve({ ok: false, reason: 'badState' })
        const handle = beginDialogFetch()
        return request(ROUTE.candidates, clearCandidatesBody(clear), handle.controller.signal).then(function (envelope) {
          if (!settleDialogFetch(handle)) return { ok: false, reason: 'superseded' }
          if (envelope.transport) {
            failDelete('plan', { transport: envelope.transport })
            return { ok: false, reason: envelope.transport }
          }
          if (envelope.ok !== true) {
            failDelete('plan', toApiError(envelope))
            return { ok: false, reason: 'api', error: toApiError(envelope) }
          }
          if (!Array.isArray(envelope.candidates)) {
            failDelete('plan', { transport: 'badResponse' })
            return { ok: false, reason: 'badResponse' }
          }
          const picked = clearTargetsFrom(envelope.candidates, clear.excluded)
          const total = typeof envelope.total === 'number' && envelope.total >= 0 ? envelope.total : envelope.candidates.length
          const absorbed = absorbSkipped(clear, picked.skippedTargets)
          if (picked.targets.length === 0) {
            if (picked.skippedTargets.length > 0 && skippedRowsWaitForRestart(envelope.candidates)) {
              // Every log waits only on this app run: show them with their blockers and offer the
              // "runs after this app exits" route instead of a dead end.
              const batch = picked.skippedTargets.slice(0, CLEAR_BATCH_TARGETS)
              dialogStore.setState({
                clear: Object.assign({}, dialogStore.getSnapshot().clear, {
                  total: total,
                  deletable: 0,
                  skipped: absorbed.skipped,
                  skippedKeys: absorbed.skippedKeys,
                  queued: picked.skippedTargets.slice(CLEAR_BATCH_TARGETS),
                  truncated: false,
                }),
                targets: batch,
                selection: batch.map(targetKey),
              })
              startPlan()
              return { ok: true, empty: false, total: total, deferredRoute: true }
            }
            // Nothing can be cleared now (no logs, or blockers a restart would not clear): say so
            // in the dialog instead of a toast that vanishes with the reason still unknown.
            dialogStore.setState({
              phase: 'done',
              refreshing: false,
              failureStage: null,
              error: null,
              result: null,
              clear: Object.assign({}, dialogStore.getSnapshot().clear, {
                total: total,
                deletable: 0,
                skipped: absorbed.skipped,
                skippedKeys: absorbed.skippedKeys,
                stop: { code: 'empty', remaining: total },
              }),
            })
            return { ok: true, empty: true, total: total, skipped: absorbed.skipped }
          }
          const current = dialogStore.getSnapshot()
          dialogStore.setState({
            clear: Object.assign({}, current.clear, {
              total: total,
              deletable: picked.targets.length,
              skipped: absorbed.skipped,
              skippedKeys: absorbed.skippedKeys,
              queued: picked.targets.slice(CLEAR_BATCH_TARGETS),
              truncated: envelope.truncated === true,
            }),
            targets: picked.targets.slice(0, CLEAR_BATCH_TARGETS),
            selection: picked.targets.slice(0, CLEAR_BATCH_TARGETS).map(targetKey),
          })
          startPlan()
          return { ok: true, empty: false, total: total }
        }).catch(function (error) {
          if (isAbortError(error)) return { ok: false, reason: 'superseded' }
          if (!settleDialogFetch(handle)) return { ok: false, reason: 'superseded' }
          failDelete('plan', { transport: 'network' })
          return { ok: false, reason: 'network' }
        })
      }

      /** Retry the pre-flight of a clear that failed before any batch existed. */
      function reopenClearPreflight(clear) {
        dialogStore.setState(Object.assign(initialDialogState(), {
          phase: 'planning',
          surface: 'overlay',
          clear: initialClearState({ id: clear.workspaceId, title: clear.title }),
        }))
        void runClearPreflight()
      }

      /** Stable host element that outlives the settings panel the dialog was opened from. */
      function stableFocusFallback() {
        if (typeof document === 'undefined') return null
        const selectors = [
          '[data-dsh-settings-trigger]',
          '[data-testid="settings-trigger"]',
          '[data-settings-trigger]',
          '[role="main"]',
          '[data-dsh-app-frame]',
          '#root',
        ]
        for (let i = 0; i < selectors.length; i += 1) {
          let candidate = null
          try { candidate = document.querySelector(selectors[i]) } catch (error) { candidate = null }
          if (!candidate || candidate === document.body) continue
          return candidate
        }
        return null
      }

      function focusWithoutScroll(element) {
        if (!element || typeof element.focus !== 'function') return false
        if (element.isConnected === false) return false
        try { element.focus({ preventScroll: true }) } catch (error) {
          try { element.focus() } catch (ignored) { return false }
        }
        return typeof document !== 'undefined' && document.activeElement === element
      }

      /**
       * Focus-restore fallback: the element that opened the dialog often lives in
       * the settings section, which the host unmounts before the dialog appears.
       * Focus must not silently fall to <body> in that case, so fall back to a
       * stable host control (sidebar settings trigger or app frame), made
       * programmatically focusable for that one call and restored right after.
       */
      function focusStableFallback() {
        const fallback = stableFocusFallback()
        if (!fallback) return false
        if (focusWithoutScroll(fallback)) return true
        const alreadyProgrammatic = fallback.getAttribute('tabindex') === '-1'
        if (!alreadyProgrammatic) fallback.setAttribute('tabindex', '-1')
        const focused = focusWithoutScroll(fallback)
        if (focused && !alreadyProgrammatic) {
          fallback.addEventListener('blur', function () {
            if (fallback.getAttribute('tabindex') === '-1') fallback.removeAttribute('tabindex')
          }, { once: true })
        }
        return focused
      }

      function restoreFocus() {
        const target = returnFocus
        returnFocus = null
        if (target && focusWithoutScroll(target)) return
        focusStableFallback()
      }

      function closeDialog() {
        clearDoneTimer()
        abortDialogFetch()
        dialogStore.setState(initialDialogState())
        restoreFocus()
      }

      function dismissDialog() {
        const phase = dialogStore.getSnapshot().phase
        if (phase === 'idle' || phase === 'deleting' || phase === 'deferring') return
        closeDialog()
      }

      function disposeDialog() {
        clearDoneTimer()
        abortDialogFetch()
        dialogStore.setState(initialDialogState())
        returnFocus = null
      }

      function retryDialog() {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'failed') return
        // A workspace clear keeps its folded totals: retrying resumes the walk instead of dropping
        // back to a single-batch review (or closing the window and losing the summary).
        if (state.clear !== null) {
          if (state.clear.truncated === true && state.clear.rounds < CLEAR_MAX_ROUNDS) {
            dialogStore.setState({
              phase: 'deleting',
              failureStage: null,
              error: null,
              refreshing: false,
              clear: Object.assign({}, state.clear, { resyncs: 0 }),
            })
            refillClearQueue()
            return
          }
          if (state.targets.length > 0) {
            // An explicit retry gets a fresh `UNKNOWN_SESSION` budget: the user asked to try again,
            // so the walk may rebuild the queue a couple more times instead of dead-ending on the
            // previous attempt's exhausted counter.
            dialogStore.setState({
              phase: 'deleting',
              failureStage: null,
              error: null,
              refreshing: false,
              deletingStartedAt: Date.now(),
              clear: Object.assign({}, state.clear, { resyncs: 0 }),
            })
            runClearBatch()
            return
          }
          // Nothing is in flight: the failure happened before any batch, so re-run the pre-flight.
          reopenClearPreflight(state.clear)
          return
        }
        if (state.targets.length === 0) {
          closeDialog()
          return
        }
        if (state.failureStage === 'defer') {
          // The plan is still the one the user reviewed; retrying the queue write
          // must not consume time re-planning.
          dialogStore.setState({ phase: 'review', failureStage: null, error: null, refreshing: false })
          deferPlan()
          return
        }
        startPlan()
      }

      function setDialogMode(mode) {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        if (mode !== 'trash' && mode !== 'permanent') return
        if (mode === state.mode) return
        if (mode === 'permanent') {
          if (state.plan && state.plan.allowPermanentDeletion === false) return
          // The refusal is about the targets that are actually planned, not every reviewed row.
          const planned = plannedTargets(state)
          let workspaceTargets = 0
          for (let i = 0; i < planned.length; i += 1) {
            if (planned[i].kind === 'workspace') workspaceTargets += 1
          }
          if (workspaceTargets > 1) return
        }
        dialogStore.setState({ mode: mode, typed: '', modeNotice: false })
        startPlan()
      }

      function setIncludeSessions(value) {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        if (state.includeSessions === (value === true)) return
        dialogStore.setState({ includeSessions: value === true, typed: '' })
        startPlan()
      }

      /**
       * Keep `clear.excluded` in step with the visible batch's checkboxes: an un-checked row must
       * not be swept up again when the walk refills from the next candidates page.
       */
      function clearExclusionPatch(clear, targets, selection) {
        if (clear === null) return null
        const included = {}
        for (let i = 0; i < selection.length; i += 1) included[selection[i]] = true
        const excluded = Object.assign({}, clear.excluded)
        for (let i = 0; i < targets.length; i += 1) {
          const key = targetKey(targets[i])
          if (included[key] === true) delete excluded[key]
          else excluded[key] = true
        }
        return Object.assign({}, clear, { excluded: excluded })
      }

      /** Store patch for a new selection: it also resets the typed confirmation and exclusions. */
      function selectionPatch(state, selection) {
        return {
          selection: selection,
          typed: '',
          clear: clearExclusionPatch(state.clear, state.targets, selection),
        }
      }

      /**
       * Review checkbox. Only checked targets are planned, so un-checking a row re-plans without
       * it — also inside a workspace clear, where the un-checked row is additionally excluded from
       * the remaining batches.
       */
      function setDialogSelection(key, checked) {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        if (typeof key !== 'string' || key === '') return
        const selected = {}
        for (let i = 0; i < state.selection.length; i += 1) selected[state.selection[i]] = true
        const wasChecked = selected[key] === true
        if ((checked === true) === wasChecked) return
        if (checked === true) selected[key] = true
        else delete selected[key]
        dialogStore.setState(selectionPatch(state, Object.keys(selected)))
        startPlan()
      }

      /** Invert every reviewed row ("反选"), which may leave nothing checked. */
      function invertDialogTargetSelection() {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        const selected = {}
        for (let i = 0; i < state.selection.length; i += 1) selected[state.selection[i]] = true
        const next = []
        for (let i = 0; i < state.targets.length; i += 1) {
          const key = targetKey(state.targets[i])
          if (selected[key] !== true) next.push(key)
        }
        dialogStore.setState(selectionPatch(state, next))
        startPlan()
      }

      /** Include or exclude subagent descendants (SPEC §4.3 `includeDescendants`). */
      function setIncludeDescendants(value) {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        if (state.clear !== null) return
        if (state.includeDescendants === (value === true)) return
        dialogStore.setState({ includeDescendants: value === true, typed: '', descendantsAutoOff: false })
        startPlan()
      }

      /** Re-check every reviewed row after the user narrowed the selection. */
      function selectAllDialogTargets() {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        if (state.selection.length === state.targets.length) return
        dialogStore.setState(selectionPatch(state, state.targets.map(targetKey)))
        startPlan()
      }

      function setTypedText(value) {
        const state = dialogStore.getSnapshot()
        if (state.phase !== 'review' || state.refreshing === true) return
        dialogStore.setState({ typed: typeof value === 'string' ? value : '' })
      }

      /**
       * Queue the reviewed deletion for the next DSH start (task-9). Only offered
       * for plans whose only blockers are cleared by a restart, so the queued
       * entry is expected to succeed then. Sends the reviewed mode/options and, for
       * a permanent workspace-dir plan, the typed confirmation text.
       */
      function deferPlan() {
        const state = dialogStore.getSnapshot()
        const plan = state.plan
        if (state.phase !== 'review' || state.refreshing === true || !plan) return
        if (!Array.isArray(plan.targets) || plan.targets.length === 0) {
          dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'defer', error: { transport: 'badResponse' } })
          return
        }
        if (!planDeferrability(plan).canDefer) return
        const confirmation = isTypedConfirmation(plan.confirmation) ? plan.confirmation : null
        if (confirmation !== null && state.typed.trim() !== String(confirmation.expected)) return
        const handle = beginDialogFetch()
        const body = deferRequestBody(state, plan)
        dialogStore.setState({ phase: 'deferring', error: null, failureStage: null, deferred: null })
        request(ROUTE.defer, body, handle.controller.signal).then(function (envelope) {
          if (!settleDialogFetch(handle)) return
          if (envelope.transport) {
            dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'defer', error: { transport: envelope.transport } })
            return
          }
          if (envelope.ok !== true) {
            dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'defer', error: toApiError(envelope) })
            return
          }
          if (!isDeferResult(envelope.deferred)) {
            dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'defer', error: { transport: 'badResponse' } })
            return
          }
          const deferred = envelope.deferred
          const entryIds = []
          for (let i = 0; i < deferred.entryIds.length; i += 1) {
            if (typeof deferred.entryIds[i] === 'string' && deferred.entryIds[i] !== '') entryIds.push(deferred.entryIds[i])
          }
          const count = deferred.count > 0 ? Math.floor(deferred.count) : 0
          dialogStore.setState({
            phase: 'deferred',
            refreshing: false,
            failureStage: null,
            error: null,
            deferred: { count: count, entryIds: entryIds, replaced: deferred.replaced === true, mode: body.mode },
          })
          // Any mounted settings page should reload its deferred notice.
          mutations.bump()
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (!settleDialogFetch(handle)) return
          dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: 'defer', error: { transport: 'network' } })
        })
      }

      function confirmDelete() {
        const state = dialogStore.getSnapshot()
        const plan = state.plan
        if (state.phase !== 'review' || state.refreshing === true || !plan) return
        if (Array.isArray(plan.blockers) && plan.blockers.length > 0) return
        const confirmation = isTypedConfirmation(plan.confirmation) ? plan.confirmation : null
        const typed = state.typed.trim()
        if (confirmation !== null && typed !== String(confirmation.expected)) return
        const handle = beginDialogFetch()
        dialogStore.setState({ phase: 'deleting', error: null, failureStage: null, deletingStartedAt: Date.now() })
        executePlan(plan, confirmation !== null ? typed : '', handle.controller.signal).then(function (outcome) {
          if (!settleDialogFetch(handle)) return
          if (!outcome.ok) {
            failDelete('delete', outcome.error)
            return
          }
          // A workspace clear keeps going batch by batch instead of settling on the first result.
          if (dialogStore.getSnapshot().clear !== null) {
            advanceClear(outcome.result)
            return
          }
          finishDelete(outcome.result)
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (!settleDialogFetch(handle)) return
          failDelete('delete', { transport: 'network' })
        })
      }

      // --------------------------------------------------- delete result / batches

      function resultCounts(result) {
        const totals = result && result.totals && typeof result.totals === 'object' ? result.totals : {}
        return {
          count: (typeof totals.trashed === 'number' ? totals.trashed : 0) + (typeof totals.deleted === 'number' ? totals.deleted : 0),
          bytes: typeof totals.bytes === 'number' ? totals.bytes : 0,
          failed: typeof totals.failed === 'number' ? totals.failed : 0,
        }
      }

      /**
       * One plan → admission → execute round. Resolves instead of writing a phase, so the batch
       * walker can decide whether to continue, stop or report a failure.
       */
      function executePlan(plan, typedText, signal) {
        const body = { planId: plan.planId }
        if (typeof typedText === 'string' && typedText !== '') body.confirmationText = typedText
        return request(ROUTE.delete, body, signal).then(function (envelope) {
          if (envelope.transport) return { ok: false, error: { transport: envelope.transport } }
          if (envelope.ok !== true) return { ok: false, error: toApiError(envelope) }
          if (!isDeleteResult(envelope.result)) return { ok: false, error: { transport: 'badResponse' } }
          return { ok: true, result: envelope.result }
        })
      }

      /** Settle a one-shot deletion: show the result and let a clean one dismiss itself. */
      function finishDelete(result) {
        dialogStore.setState({ phase: 'done', refreshing: false, failureStage: null, error: null, result: result })
        notifyMutation()
        clearDoneTimer()
        // Only a fully successful result may dismiss itself; a result with failed items stays on
        // screen (and in the live region) until the user explicitly closes it. A review preserved
        // across a settings-sheet unmount stays until the user closes it too (SPEC §9).
        if (resultCounts(result).failed === 0 && dialogStore.getSnapshot().keepSummary !== true) {
          doneTimer = setTimeout(function () {
            doneTimer = null
            if (dialogStore.getSnapshot().phase === 'done') closeDialog()
          }, DONE_VISIBLE_MS)
        }
      }

      function failDelete(stage, error) {
        dialogStore.setState({ phase: 'failed', refreshing: false, failureStage: stage, error: error })
      }

      /** `kind:id` keys a delete result reports as removed from disk. */
      function completedTargetKeys(result) {
        const keys = Object.create(null)
        const items = result && Array.isArray(result.items) ? result.items : []
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          if (!item || typeof item.id !== 'string') continue
          if (item.status !== 'trashed' && item.status !== 'deleted') continue
          keys[String(item.kind) + ':' + item.id] = true
        }
        return keys
      }

      /**
       * Advance a workspace clear after one executed batch: fold its counts, then start the next
       * batch, refill from the Host when the page is drained, or settle. No batch is reviewed on
       * its own — the review the user confirmed covers the whole clear.
       */
      function advanceClear(result) {
        const state = dialogStore.getSnapshot()
        const clear = state.clear
        if (clear === null) return
        const counts = resultCounts(result)
        // A batch plan expands subagent descendants, so a batch can delete a log that is queued for
        // a later batch. Prune those ids before the next plan: planning a vanished target fails the
        // whole batch with UNKNOWN_SESSION (SPEC §9).
        const completed = completedTargetKeys(result)
        const queued = clear.queued.filter(function (target) { return completed[targetKey(target)] !== true })
        const next = Object.assign({}, clear, {
          queued: queued,
          resyncs: 0,
          done: {
            count: clear.done.count + counts.count,
            bytes: clear.done.bytes + counts.bytes,
            failed: clear.done.failed + counts.failed,
          },
          batches: clear.batches + 1,
        })
        notifyMutation()
        if (next.queued.length > 0) {
          const nextBatch = next.queued.slice(0, CLEAR_BATCH_TARGETS)
          dialogStore.setState({
            targets: nextBatch,
            selection: nextBatch.map(targetKey),
            plan: null,
            refreshing: false,
            clear: Object.assign({}, next, { queued: next.queued.slice(CLEAR_BATCH_TARGETS) }),
          })
          runClearBatch()
          return
        }
        if (next.truncated === true && next.rounds < CLEAR_MAX_ROUNDS) {
          dialogStore.setState({ targets: [], plan: null, refreshing: false, clear: Object.assign({}, next, { queued: [] }) })
          refillClearQueue()
          return
        }
        dialogStore.setState({ targets: [], plan: null, clear: next })
        settleClear(next.truncated === true ? 'limit' : null)
      }

      /** End a clear: `stopCode` null means the workspace is drained. */
      function settleClear(stopCode, stopRemaining) {
        const state = dialogStore.getSnapshot()
        const clear = state.clear
        if (clear === null) return
        // What is left when the walk stops early: an explicit count when the caller knows it,
        // otherwise the queue plus the batch that was not executed.
        const remaining = stopCode === null
          ? 0
          : (typeof stopRemaining === 'number' && stopRemaining >= 0
            ? stopRemaining
            : clear.queued.length + (Array.isArray(state.targets) ? state.targets.length : 0))
        dialogStore.setState({
          phase: 'done',
          refreshing: false,
          failureStage: null,
          error: null,
          result: null,
          clear: Object.assign({}, clear, { stop: stopCode === null ? null : { code: stopCode, remaining: remaining } }),
        })
        clearDoneTimer()
        const excludedCount = clear.excluded && typeof clear.excluded === 'object' ? Object.keys(clear.excluded).length : 0
        // Only a fully drained clear may dismiss itself. "Skipped", "excluded" or a stopped walk all
        // mean the workspace is not empty, so the summary must stay until the user closes it (SPEC §9).
        if (stopCode === null && clear.done.failed === 0 && clear.skipped === 0 && excludedCount === 0 && dialogStore.getSnapshot().keepSummary !== true) {
          doneTimer = setTimeout(function () {
            doneTimer = null
            if (dialogStore.getSnapshot().phase === 'done') closeDialog()
          }, DONE_VISIBLE_MS)
        }
      }

      /** True when a clear batch plan brings back a target the user un-checked earlier. */
      function planLeaksExcludedTargets(plan, clear) {
        if (!clear || typeof clear !== 'object') return false
        const excluded = clear.excluded && typeof clear.excluded === 'object' ? clear.excluded : null
        if (excluded === null) return false
        const items = plan && Array.isArray(plan.items) ? plan.items : []
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          if (!item || item.kind !== 'session' || typeof item.id !== 'string') continue
          if (excluded['session:' + item.id] === true) return true
        }
        return false
      }

      /**
       * Plan and execute the current batch without returning to the review state. The batch first
       * asks for descendant expansion (a clear deletes every log); when that brings back a target the
       * user un-checked in this batch, it re-plans without descendants once, and refuses if the target
       * still leaks — a checkbox the user cleared must never be deleted by a later batch (SPEC §9).
       */
      function runClearBatch() {
        requestClearBatchPlan(true)
      }

      /** @param {boolean} includeDescendants - ask the Host for the subagent closure. */
      function requestClearBatchPlan(includeDescendants) {
        const state = dialogStore.getSnapshot()
        if (state.clear === null || state.targets.length === 0) return
        const handle = beginDialogFetch()
        const body = {
          targets: state.targets.map(function (target) { return { kind: target.kind, id: target.id } }),
          mode: state.mode,
          includeSessions: false,
          includeDescendants: includeDescendants === true,
        }
        request(ROUTE.plan, body, handle.controller.signal).then(function (envelope) {
          if (!settleDialogFetch(handle)) return
          if (envelope.transport) { failDelete('plan', { transport: envelope.transport }); return }
          if (envelope.ok !== true) {
            const error = toApiError(envelope)
            // A reviewed target can disappear outside this app run (another Host process, a second
            // window). The Host refuses the whole plan for it, so rebuild the queue from fresh
            // candidates instead of aborting the walk (SPEC §9).
            if (error.code === 'UNKNOWN_SESSION' && state.clear !== null && state.clear.resyncs < CLEAR_RESYNC_MAX) {
              resyncClearQueue()
              return
            }
            failDelete('plan', error)
            return
          }
          const plan = envelope.plan
          if (!isPlan(plan)) { failDelete('plan', { transport: 'badResponse' }); return }
          if (planLeaksExcludedTargets(plan, dialogStore.getSnapshot().clear)) {
            if (includeDescendants) {
              requestClearBatchPlan(false)
              return
            }
            // Even without descendants the plan still contains an un-checked row: fail closed.
            failDelete('plan', { code: 'UNCHECKED_TARGET_LEAK' })
            return
          }
          if (Array.isArray(plan.blockers) && plan.blockers.length > 0) {
            // A target became undeletable between batches: keep the plan for context and stop.
            dialogStore.setState({ plan: plan, refreshing: false })
            settleClear('blocked')
            return
          }
          const typed = isTypedConfirmation(plan.confirmation) ? String(plan.confirmation.expected) : ''
          dialogStore.setState({ plan: plan, mode: plan.mode === 'permanent' ? 'permanent' : 'trash', refreshing: false })
          const execHandle = beginDialogFetch()
          executePlan(plan, typed, execHandle.controller.signal).then(function (outcome) {
            if (!settleDialogFetch(execHandle)) return
            if (!outcome.ok) { failDelete('delete', outcome.error); return }
            advanceClear(outcome.result)
          }).catch(function (error) {
            if (isAbortError(error)) return
            if (!settleDialogFetch(execHandle)) return
            failDelete('delete', { transport: 'network' })
          })
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (!settleDialogFetch(handle)) return
          failDelete('plan', { transport: 'network' })
        })
      }

      /**
       * Recover a clear whose batch plan named a target that no longer exists: re-read the
       * workspace, keep the exclusions and folded totals, and continue with a fresh queue. Bounded
       * by CLEAR_RESYNC_MAX so a repeatedly failing Host cannot loop forever (SPEC §9).
       */
      function resyncClearQueue() {
        const state = dialogStore.getSnapshot()
        const clear = state.clear
        if (clear === null) return
        dialogStore.setState({ clear: Object.assign({}, clear, { resyncs: clear.resyncs + 1 }) })
        const handle = beginDialogFetch()
        request(ROUTE.candidates, clearCandidatesBody(clear), handle.controller.signal).then(function (envelope) {
          if (!settleDialogFetch(handle)) return
          if (envelope.transport) { failDelete('plan', { transport: envelope.transport }); return }
          if (envelope.ok !== true) { failDelete('plan', toApiError(envelope)); return }
          if (!Array.isArray(envelope.candidates)) { failDelete('plan', { transport: 'badResponse' }); return }
          const current = dialogStore.getSnapshot().clear
          if (current === null) return
          const picked = clearTargetsFrom(envelope.candidates, current.excluded)
          const absorbed = absorbSkipped(current, picked.skippedTargets)
          const pageTotal = typeof envelope.total === 'number' && envelope.total >= 0 ? envelope.total : envelope.candidates.length
          if (picked.targets.length === 0) {
            dialogStore.setState({
              targets: [],
              plan: null,
              refreshing: false,
              clear: Object.assign({}, current, { skipped: absorbed.skipped, skippedKeys: absorbed.skippedKeys, queued: [] }),
            })
            settleClear(pageTotal > 0 && absorbed.added > 0 ? 'blocked' : null, pageTotal)
            return
          }
          const nextBatch = picked.targets.slice(0, CLEAR_BATCH_TARGETS)
          dialogStore.setState({
            targets: nextBatch,
            selection: nextBatch.map(targetKey),
            plan: null,
            refreshing: false,
            clear: Object.assign({}, current, {
              skipped: absorbed.skipped,
              skippedKeys: absorbed.skippedKeys,
              queued: picked.targets.slice(CLEAR_BATCH_TARGETS),
              truncated: envelope.truncated === true,
            }),
          })
          runClearBatch()
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (!settleDialogFetch(handle)) return
          failDelete('plan', { transport: 'network' })
        })
      }

      /** Load the next candidates page after the queue drained mid-workspace. */
      function refillClearQueue() {
        const state = dialogStore.getSnapshot()
        const clear = state.clear
        if (clear === null) return
        const handle = beginDialogFetch()
        request(ROUTE.candidates, clearCandidatesBody(clear), handle.controller.signal).then(function (envelope) {
          if (!settleDialogFetch(handle)) return
          if (envelope.transport) { failDelete('plan', { transport: envelope.transport }); return }
          if (envelope.ok !== true) { failDelete('plan', toApiError(envelope)); return }
          if (!Array.isArray(envelope.candidates)) { failDelete('plan', { transport: 'badResponse' }); return }
          const picked = clearTargetsFrom(envelope.candidates, clear.excluded)
          const absorbed = absorbSkipped(clear, picked.skippedTargets)
          // A page that yields nothing deletable may still hold matches. Only rows not already counted
          // as skipped mean the walk is actually blocked; a page that merely repeats known in-use
          // Sessions is drained, and reporting it as blocked would double count them (SPEC §9).
          const pageTotal = typeof envelope.total === 'number' ? envelope.total : envelope.candidates.length
          if (picked.targets.length === 0) {
            dialogStore.setState({ clear: Object.assign({}, clear, { skipped: absorbed.skipped, skippedKeys: absorbed.skippedKeys }) })
            settleClear(absorbed.added > 0 && pageTotal > 0 ? 'blocked' : null, pageTotal)
            return
          }
          const nextBatch = picked.targets.slice(0, CLEAR_BATCH_TARGETS)
          dialogStore.setState({
            targets: nextBatch,
            selection: nextBatch.map(targetKey),
            plan: null,
            clear: Object.assign({}, clear, {
              queued: picked.targets.slice(CLEAR_BATCH_TARGETS),
              truncated: envelope.truncated === true,
              skipped: absorbed.skipped,
              skippedKeys: absorbed.skippedKeys,
              rounds: clear.rounds + 1,
            }),
          })
          runClearBatch()
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (!settleDialogFetch(handle)) return
          failDelete('plan', { transport: 'network' })
        })
      }

      return {
        store: dialogStore,
        openDialog: openDialog,
        openWorkspaceClear: openWorkspaceClear,
        closeDialog: closeDialog,
        dismissDialog: dismissDialog,
        disposeDialog: disposeDialog,
        retryDialog: retryDialog,
        deferPlan: deferPlan,
        confirmDelete: confirmDelete,
        setDialogMode: setDialogMode,
        setDialogSelection: setDialogSelection,
        invertDialogTargetSelection: invertDialogTargetSelection,
        setIncludeDescendants: setIncludeDescendants,
        selectAllDialogTargets: selectAllDialogTargets,
        setIncludeSessions: setIncludeSessions,
        setTypedText: setTypedText,
      }
    }

    /**
     * Per-request-family lifetime bookkeeping for the settings page: one abortable
     * controller per family, a monotonic token so a superseded response is dropped,
     * and one dispose that cancels everything. This replaces the hand-written
     * `begin`/`release`/`seq` boilerplate each loader used to carry.
     * @returns {{ begin: Function, stale: Function, end: Function, dispose: Function }}
     */
    function createRequestTracker() {
      const controllers = {}
      const sequences = {}
      return {
        /** Start (and abort the previous) request for one family. */
        begin: function (family) {
          const key = typeof family === 'string' && family !== '' ? family : 'default'
          const previous = controllers[key]
          if (previous) { try { previous.abort() } catch (error) { /* ignore */ } }
          const controller = new AbortController()
          controllers[key] = controller
          sequences[key] = (sequences[key] || 0) + 1
          return { key: key, controller: controller, seq: sequences[key] }
        },
        /** True when a newer request has since started (the response must be ignored). */
        stale: function (handle) {
          return !handle || controllers[handle.key] !== handle.controller || sequences[handle.key] !== handle.seq
        },
        /** Release the controller slot if this handle is still the current one. */
        end: function (handle) {
          if (!handle) return
          if (controllers[handle.key] === handle.controller) controllers[handle.key] = null
        },
        /** Abort and invalidate every family (page unmount). */
        dispose: function () {
          const keys = Object.keys(controllers)
          for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i]
            sequences[key] = (sequences[key] || 0) + 1
            const controller = controllers[key]
            delete controllers[key]
            if (controller) { try { controller.abort() } catch (error) { /* ignore */ } }
          }
        },
      }
    }

    /**
     * Settings-page store factory, one per mounted page (SPEC §10): inventory, measurement,
     * trash, deferred queue, retained list, cleanup settings and audit. Fetch lifetimes use
     * `createRequestTracker`; the store itself is plain immutable state.
     * @param {{ t: Function, notifyMutation: Function }} deps - wiring.
     * @returns {object} page store handle.
     */
    function createPageStore(deps) {
      const t = deps.t
      const notifyMutation = deps.notifyMutation
      const pageStore = createStore(initialPageState())
      // One tracker for every request family (inventory/trash/deferred/settings/...):
      // it owns the AbortController per family and drops superseded responses by token.
      const requests = createRequestTracker()
      let actionNoticeSeq = 0
      let deferredNoticeSeq = 0
      let retainedNoticeSeq = 0
      let deferredFocusSeq = 0
      let retainedFocusSeq = 0
      let disposed = false
      let lastDeferredAction = null
      let lastRetainedAction = null
      // The retry closure remembers the operation AND the re-entry point,
      // so `retryAction` re-runs through `runAction` (busy flag, abort handle,
      // one in-flight request, reload on success) instead of a bare fetch.
      let lastAction = null

      /** Drop a measurement only when its target is gone from the inventory. */
      function pruneMeasured(previous, alive) {
        const next = {}
        if (previous && typeof previous === 'object') {
          const keys = Object.keys(previous)
          for (let i = 0; i < keys.length; i += 1) {
            if (alive[keys[i]] === true) next[keys[i]] = previous[keys[i]]
          }
        }
        return next
      }

      function loadInventory() {
        const handle = requests.begin('inventory')
        const controller = handle.controller
        pageStore.setState({ inventoryLoading: true, inventoryError: null })
        return request(ROUTE.inventory, {}, controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope.transport || envelope.ok !== true) {
            pageStore.setState({ inventoryLoading: false, inventoryError: toApiError(envelope) })
            return
          }
          const inventory = normalizeInventory(envelope)
          if (trashNeedsSettings(trashOf(inventory))) ensureSettingsLoaded()
          pageStore.setState(function (current) {
            const workspaceIds = {}
            for (let i = 0; i < inventory.workspaces.length; i += 1) workspaceIds[inventory.workspaces[i].id] = true
            const sessionIds = {}
            for (let i = 0; i < inventory.sessions.length; i += 1) sessionIds[inventory.sessions[i].id] = true
            const measured = current.measured || {}
            // F8: a queue that emptied elsewhere must not leave an armed "cancel all"
            // behind — it would let one later click cancel a newly queued batch.
            const deferredCount = inventory.deferred && typeof inventory.deferred.count === 'number'
              ? inventory.deferred.count
              : 0
            const deferredConfirm = deferredCount === 0 ? null : current.deferredConfirm
            // A suggested-purge arm only makes sense while the capacity warning exists.
            const capacityWarning = !!(inventory.trash && inventory.trash.overCapacity)
            const confirmPurge = current.confirmPurge === 'suggest' && !capacityWarning ? null : current.confirmPurge
            return Object.assign({}, current, {
              inventoryLoading: false,
              inventoryError: null,
              inventory: inventory,
              confirmPurge: confirmPurge,
              confirmPurgeAt: confirmPurge === current.confirmPurge ? current.confirmPurgeAt : 0,
              measured: {
                workspaces: pruneMeasured(measured.workspaces, workspaceIds),
                sessions: pruneMeasured(measured.sessions, sessionIds),
              },
              selected: current.selected.filter(function (id) { return workspaceIds[id] === true }),
              selectedSessions: current.selectedSessions.filter(function (id) { return sessionIds[id] === true }),
              deferredConfirm: deferredConfirm,
              deferredConfirmAt: deferredConfirm === current.deferredConfirm ? current.deferredConfirmAt : 0,
            })
          })
        }).catch(function (error) {
          if (isAbortError(error) || requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({ inventoryLoading: false, inventoryError: { transport: 'network' } })
        })
      }

      function loadTrash() {
        const handle = requests.begin('trash')
        const controller = handle.controller
        pageStore.setState({ trashLoading: true, trashError: null })
        return request(ROUTE.trashList, {}, controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope.transport || envelope.ok !== true) {
            pageStore.setState({ trashLoading: false, trashError: toApiError(envelope) })
            return
          }
          const trash = normalizeTrash(envelope)
          pageStore.setState(function (current) {
            // If the armed entry disappeared (restored elsewhere / refreshed
            // away), disarm instead of leaving an invisible pending confirmation.
            let confirmPurge = current.confirmPurge
            if (confirmPurge !== null && confirmPurge !== 'all') {
              const entries = Array.isArray(trash.entries) ? trash.entries : []
              let found = false
              for (let i = 0; i < entries.length; i += 1) {
                if (String(entries[i].id) === String(confirmPurge)) { found = true; break }
              }
              if (!found) confirmPurge = null
            }
            return Object.assign({}, current, {
              trashLoading: false,
              trashError: null,
              trashLoaded: true,
              trash: trash,
              confirmPurge: confirmPurge,
              confirmPurgeAt: confirmPurge === current.confirmPurge ? current.confirmPurgeAt : 0,
            })
          })
          const inventoryTrash = trashOf(pageStore.getSnapshot().inventory)
          if (trashNeedsSettings(inventoryTrash)) ensureSettingsLoaded()
        }).catch(function (error) {
          if (isAbortError(error) || requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({ trashLoading: false, trashError: { transport: 'network' } })
        })
      }

      /** Load the queued-deletion entries (lazy: only when the notice is expanded). */
      function loadDeferred() {
        const handle = requests.begin('deferred')
        const controller = handle.controller
        pageStore.setState({ deferredLoading: true, deferredError: null })
        return request(ROUTE.deferredList, {}, controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope.transport || envelope.ok !== true) {
            pageStore.setState({ deferredLoading: false, deferredError: toApiError(envelope) })
            return
          }
          const deferred = normalizeDeferredList(envelope)
          pageStore.setState(function (current) {
            // If the armed entry vanished (cancelled elsewhere / reloaded) or the
            // whole queue is gone, disarm; a stale arm must not cancel a new queue.
            let deferredConfirm = current.deferredConfirm
            if (deferredConfirm !== null && deferred.entries.length === 0) deferredConfirm = null
            if (deferredConfirm !== null && deferredConfirm !== 'all') {
              let found = false
              for (let i = 0; i < deferred.entries.length; i += 1) {
                if (deferred.entries[i].id === deferredConfirm) { found = true; break }
              }
              if (!found) deferredConfirm = null
            }
            // The retained arm dies with its entry (forgot elsewhere / reloaded away).
            let retainedConfirm = current.retainedConfirm
            if (retainedConfirm !== null && retainedConfirm !== undefined) {
              let retainedFound = false
              for (let i = 0; i < deferred.retained.length; i += 1) {
                if (deferred.retained[i].id === retainedConfirm.id) { retainedFound = true; break }
              }
              if (!retainedFound) retainedConfirm = null
            }
            return Object.assign({}, current, {
              deferredLoading: false,
              deferredError: null,
              deferredLoaded: true,
              deferred: deferred,
              deferredConfirm: deferredConfirm,
              deferredConfirmAt: deferredConfirm === current.deferredConfirm ? current.deferredConfirmAt : 0,
              retainedConfirm: retainedConfirm,
              retainedConfirmAt: retainedConfirm === current.retainedConfirm ? current.retainedConfirmAt : 0,
            })
          })
        }).catch(function (error) {
          if (isAbortError(error) || requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({ deferredLoading: false, deferredError: { transport: 'network' } })
        })
      }

      // ---- cleanup wizard (SPEC §4.9) ------------------------------------------
      let wizardDebounceTimer = null
      let wizardRequestKey = null
      let wizardNoticeSeq = 0
      let wizardFocusSeq = 0

      function clearWizardDebounce() {
        if (wizardDebounceTimer !== null) {
          clearTimeout(wizardDebounceTimer)
          wizardDebounceTimer = null
        }
      }

      function abortWizardPreview() {
        wizardRequestKey = null
        const handle = requests.begin('candidates')
        requests.end(handle)
      }

      /** Open the inline wizard with fresh rules; the first preview is immediate. */
      function openWizard() {
        clearWizardDebounce()
        abortWizardPreview()
        wizardFocusSeq += 1
        pageStore.setState({
          wizardOpen: true,
          wizardFilters: defaultWizardFilters(),
          wizardSort: 'oldest',
          wizardSelected: [],
          wizardPreview: initialWizardPreview(),
          wizardNotice: null,
          wizardFocusRequest: { seq: wizardFocusSeq, target: 'panel' },
        })
        scheduleWizardPreview(0)
        return Promise.resolve()
      }

      function closeWizard() {
        clearWizardDebounce()
        abortWizardPreview()
        wizardFocusSeq += 1
        pageStore.setState({
          wizardOpen: false,
          wizardSelected: [],
          wizardPreview: initialWizardPreview(),
          wizardNotice: null,
          wizardFocusRequest: { seq: wizardFocusSeq, target: 'toggle' },
        })
        return Promise.resolve()
      }

      function clearWizardFocusRequest() {
        if (pageStore.getSnapshot().wizardFocusRequest === null) return
        pageStore.setState({ wizardFocusRequest: null })
      }

      function setWizardFilter(field, value) {
        const state = pageStore.getSnapshot()
        if (!state.wizardFilters || !Object.prototype.hasOwnProperty.call(state.wizardFilters, field)) return
        pageStore.setState(function (current) {
          const filters = Object.assign({}, current.wizardFilters)
          filters[field] = value
          return Object.assign({}, current, { wizardFilters: filters, wizardNotice: null })
        })
        scheduleWizardPreview()
        return Promise.resolve()
      }

      function setWizardSort(sort) {
        if (sort !== 'oldest' && sort !== 'largest') return
        if (pageStore.getSnapshot().wizardSort === sort) return
        pageStore.setState({ wizardSort: sort, wizardNotice: null })
        scheduleWizardPreview()
        return Promise.resolve()
      }

      function scheduleWizardPreview(delay) {
        clearWizardDebounce()
        const wait = typeof delay === 'number' ? delay : WIZARD_DEBOUNCE_MS
        wizardDebounceTimer = setTimeout(function () {
          wizardDebounceTimer = null
          runWizardPreview()
        }, wait)
      }

      /** Ask the Host for candidate rows; abortable, deduped and debounced. */
      function runWizardPreview() {
        if (disposed) return Promise.resolve()
        const state = pageStore.getSnapshot()
        if (state.wizardOpen !== true) return Promise.resolve()
        const validation = validateWizardForm(t, state.wizardFilters, state.wizardSort, state.inventory)
        if (validation.ok !== true) {
          wizardRequestKey = null
          pageStore.setState({
            wizardPreview: Object.assign(initialWizardPreview(), {
              status: 'error',
              fieldErrors: validation.fieldErrors,
            })
          })
          return Promise.resolve()
        }
        const key = JSON.stringify(validation.request)
        const preview = state.wizardPreview
        if (key === wizardRequestKey && (preview.status === 'loading' || preview.status === 'ready')) return Promise.resolve()
        wizardRequestKey = key
        const handle = requests.begin('candidates')
        pageStore.setState(function (current) {
          return Object.assign({}, current, {
            wizardPreview: Object.assign({}, current.wizardPreview, { status: 'loading', error: null, fieldErrors: {} }),
          })
        })
        return request(ROUTE.candidates, validation.request, handle.controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope.transport) {
            pageStore.setState({ wizardPreview: Object.assign(initialWizardPreview(), { status: 'error', error: { transport: envelope.transport } }) })
            return
          }
          if (envelope.ok !== true) {
            const error = toApiError(envelope)
            const field = error.details && typeof error.details.field === 'string' && error.details.field !== ''
              ? error.details.field
              : null
            if (error.code === 'BAD_REQUEST' && field !== null) {
              const formField = field === 'minBytes' ? 'minBytesMb' : field
              const fieldErrors = {}
              fieldErrors[formField] = settingsFieldError(t, error, field, wizardFieldLabel(t, field))
              pageStore.setState({ wizardPreview: Object.assign(initialWizardPreview(), { status: 'error', error: error, fieldErrors: fieldErrors }) })
              return
            }
            pageStore.setState({ wizardPreview: Object.assign(initialWizardPreview(), { status: 'error', error: error }) })
            return
          }
          const normalized = normalizeCandidates(envelope)
          wizardNoticeSeq += 1
          pageStore.setState({
            wizardPreview: {
              status: 'ready',
              candidates: normalized.candidates,
              total: normalized.total,
              truncated: normalized.truncated,
              totals: normalized.totals,
              filters: normalized.filters,
              sort: normalized.sort,
              error: null,
              fieldErrors: {},
            },
            wizardSelected: wizardDefaultSelection(normalized.candidates),
            wizardNotice: { seq: wizardNoticeSeq, kind: 'preview', count: normalized.total },
          })
        }).catch(function (error) {
          if (isAbortError(error) || requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({ wizardPreview: Object.assign(initialWizardPreview(), { status: 'error', error: { transport: 'network' } }) })
        })
      }

      function retryWizardPreview() {
        clearWizardDebounce()
        wizardRequestKey = null
        return runWizardPreview()
      }

      function toggleWizardCandidate(sessionId) {
        const state = pageStore.getSnapshot()
        if (state.wizardOpen !== true || typeof sessionId !== 'string' || sessionId === '') return
        const rows = state.wizardPreview.candidates
        let row = null
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i] && rows[i].id === sessionId) { row = rows[i]; break }
        }
        if (row === null || row.deletable !== true) return
        const selected = state.wizardSelected.slice()
        const index = selected.indexOf(sessionId)
        if (index >= 0) {
          selected.splice(index, 1)
        } else {
          if (selected.length >= WIZARD_TARGET_MAX) {
            wizardNoticeSeq += 1
            pageStore.setState({ wizardNotice: { seq: wizardNoticeSeq, kind: 'cap', count: WIZARD_TARGET_MAX } })
            return
          }
          selected.push(sessionId)
        }
        pageStore.setState({ wizardSelected: selected })
      }

      function selectAllWizardCandidates() {
        const state = pageStore.getSnapshot()
        pageStore.setState({ wizardSelected: wizardDefaultSelection(state.wizardPreview.candidates) })
      }

      function clearWizardSelection() {
        pageStore.setState({ wizardSelected: [] })
      }

      /** Choice → plan targets, in the preview's list order (never a direct delete). */
      function wizardTargets() {
        const state = pageStore.getSnapshot()
        const rows = state.wizardPreview.candidates
        const selected = state.wizardSelected
        const chosen = {}
        for (let i = 0; i < selected.length; i += 1) chosen[selected[i]] = true
        const targets = []
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (!row || chosen[row.id] !== true || row.deletable !== true) continue
          targets.push({ kind: 'session', id: row.id })
        }
        return targets
      }

      function toggleDeferredExpanded() {
        const state = pageStore.getSnapshot()
        const expanded = state.deferredExpanded !== true
        pageStore.setState({ deferredExpanded: expanded, deferredConfirm: null, deferredConfirmAt: 0 })
        if (expanded && state.deferredLoaded !== true && state.deferredLoading !== true) loadDeferred()
        return Promise.resolve()
      }

      function setDeferredConfirm(value) {
        const next = value === undefined ? null : value
        pageStore.setState({
          deferredConfirm: next,
          deferredConfirmAt: next === null ? 0 : Date.now(),
        })
      }

      function toggleDeferredLastRunExpanded() {
        pageStore.setState(function (current) {
          return Object.assign({}, current, { deferredLastRunExpanded: current.deferredLastRunExpanded !== true })
        })
        return Promise.resolve()
      }

      /** Focus handoff consumed by the mounted page after a successful cancel. */
      function clearDeferredFocusRequest() {
        if (pageStore.getSnapshot().deferredFocusRequest === null) return
        pageStore.setState({ deferredFocusRequest: null })
      }

      function runDeferredCancel(entryIds) {
        if (pageStore.getSnapshot().deferredActionBusy) return Promise.resolve()
        // Keep the original body so a retry of a failed cancel is identical.
        lastDeferredAction = { entryIds: entryIds }
        const handle = requests.begin('deferredAction')
        const controller = handle.controller
        pageStore.setState({
          deferredActionBusy: entryIds === null ? 'all' : entryIds[0],
          deferredActionError: null,
          deferredNotice: null,
        })
        const payload = entryIds === null ? { all: true } : { entryIds: entryIds }
        return request(ROUTE.deferredCancel, payload, controller.signal).then(function (envelope) {
          requests.end(handle)
          if (envelope && envelope.transport) {
            pageStore.setState({ deferredActionBusy: null, deferredActionError: { transport: envelope.transport }, deferredConfirm: null, deferredConfirmAt: 0 })
            return
          }
          if (!envelope || envelope.ok !== true) {
            pageStore.setState({ deferredActionBusy: null, deferredActionError: toApiError(envelope || {}), deferredConfirm: null, deferredConfirmAt: 0 })
            return
          }
          const cancelled = typeof envelope.cancelled === 'number' && isFinite(envelope.cancelled) && envelope.cancelled > 0
            ? Math.floor(envelope.cancelled)
            : 0
          deferredNoticeSeq += 1
          // F4: the clicked control (or the whole banner) can unmount under focus.
          // Compute where focus should land from the queue size this action leaves:
          // the Show/Hide toggle while the banner survives with a non-empty queue,
          // otherwise the page heading (both are persistent page-level controls).
          const before = pageStore.getSnapshot()
          const knownEntries = before.deferred && Array.isArray(before.deferred.entries) && before.deferredLoaded === true
            ? before.deferred.entries.length
            : null
          const inventoryCount = before.inventory && before.inventory.deferred && typeof before.inventory.deferred.count === 'number'
            ? before.inventory.deferred.count
            : 0
          const previousCount = knownEntries !== null ? knownEntries : inventoryCount
          const remaining = Math.max(0, previousCount - cancelled)
          deferredFocusSeq += 1
          pageStore.setState({
            deferredActionBusy: null,
            deferredActionError: null,
            deferredConfirm: null,
            deferredConfirmAt: 0,
            deferredNotice: { seq: deferredNoticeSeq, cancelled: cancelled },
            deferredFocusRequest: { seq: deferredFocusSeq, target: remaining > 0 ? 'toggle' : 'heading' },
          })
          loadInventory()
          if (pageStore.getSnapshot().deferredLoaded === true) loadDeferred()
        }).catch(function (error) {
          requests.end(handle)
          if (isAbortError(error)) return
          pageStore.setState({ deferredActionBusy: null, deferredActionError: { transport: 'network' }, deferredConfirm: null, deferredConfirmAt: 0 })
        })
      }

      function requestDeferredCancel(entryId) {
        const state = pageStore.getSnapshot()
        if (state.deferredActionBusy) return Promise.resolve()
        if (state.deferredConfirm === entryId) {
          // Two-step confirmation: the second click of a double click cannot cancel.
          if (Date.now() - (state.deferredConfirmAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runDeferredCancel([entryId])
        }
        setDeferredConfirm(entryId)
        return Promise.resolve()
      }

      function requestDeferredCancelAll() {
        const state = pageStore.getSnapshot()
        if (state.deferredActionBusy) return Promise.resolve()
        if (state.deferredConfirm === 'all') {
          if (Date.now() - (state.deferredConfirmAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runDeferredCancel(null)
        }
        setDeferredConfirm('all')
        return Promise.resolve()
      }

      function retryDeferredAction() {
        const action = lastDeferredAction
        if (!action) return Promise.resolve()
        return runDeferredCancel(action.entryIds)
      }

      /** Load `settings.get` (effective values + defaults + persisted flag). */
      function loadSettings() {
        const handle = requests.begin('settings')
        const controller = handle.controller
        pageStore.setState({ settingsLoading: true, settingsError: null, settingsErrorSource: null })
        return request(ROUTE.settingsGet, {}, controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope.transport || envelope.ok !== true) {
            pageStore.setState({
              settingsLoading: false,
              settingsLoaded: false,
              settingsError: toApiError(envelope),
              settingsErrorSource: 'load',
            })
            return
          }
          const normalized = normalizeSettings(envelope)
          pageStore.setState(function (current) {
            return Object.assign({}, current, {
              settingsLoading: false,
              settingsLoaded: true,
              settingsError: null,
              settingsErrorSource: null,
              settings: normalized.settings,
              settingsDefaults: normalized.defaults,
              settingsPersisted: normalized.persisted,
              settingsForm: settingsFormFromValues(normalized.settings),
              settingsFieldErrors: {},
              settingsStatus: null,
            })
          })
        }).catch(function (error) {
          if (isAbortError(error) || requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({
            settingsLoading: false,
            settingsLoaded: false,
            settingsError: { transport: 'network' },
            settingsErrorSource: 'load',
          })
        })
      }

      /** Fetch the settings once, when the settings tab (or the retention banner) first needs them. */
      function ensureSettingsLoaded() {
        const state = pageStore.getSnapshot()
        if (state.settingsLoaded === true || state.settingsLoading === true) return Promise.resolve()
        return loadSettings()
      }

      /** One form field edit; clears that field's server error and any stale status line. */
      function setSettingsField(field, value) {
        const state = pageStore.getSnapshot()
        if (!state.settingsForm) return
        if (!Object.prototype.hasOwnProperty.call(state.settingsForm, field)) return
        pageStore.setState(function (current) {
          const form = Object.assign({}, current.settingsForm)
          form[field] = value
          const fieldErrors = Object.assign({}, current.settingsFieldErrors)
          delete fieldErrors[field]
          return Object.assign({}, current, {
            settingsForm: form,
            settingsFieldErrors: fieldErrors,
            settingsStatus: null,
            settingsError: null,
            settingsErrorSource: null,
          })
        })
      }

      function setSettingsBoolean(field, value) {
        if (SETTINGS_BOOLEAN_FIELDS.indexOf(field) === -1) return
        setSettingsField(field, value === true)
      }

      /** Validate client-side (SPEC §4.8), then persist only the changed fields. */
      function saveSettings() {
        const state = pageStore.getSnapshot()
        if (state.settingsSaving === true) return Promise.resolve()
        if (!state.settings || !state.settingsForm) return Promise.resolve()
        const validated = validateSettingsForm(t, state.settingsForm, state.settings)
        if (Object.keys(validated.fieldErrors).length > 0) {
          pageStore.setState({ settingsFieldErrors: validated.fieldErrors, settingsStatus: null, settingsError: null, settingsErrorSource: null })
          return Promise.resolve()
        }
        if (Object.keys(validated.patch).length === 0) {
          pageStore.setState({ settingsFieldErrors: {}, settingsStatus: { kind: 'unchanged' } })
          return Promise.resolve()
        }
        const handle = requests.begin('settings')
        const controller = handle.controller
        pageStore.setState({
          settingsSaving: true,
          settingsFieldErrors: {},
          settingsError: null,
          settingsErrorSource: null,
          settingsStatus: null,
        })
        return request(ROUTE.settingsSet, { patch: validated.patch }, controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope && envelope.transport) {
            pageStore.setState({ settingsSaving: false, settingsError: { transport: envelope.transport }, settingsErrorSource: 'save' })
            return
          }
          if (!envelope || envelope.ok !== true) {
            const error = toApiError(envelope)
            const details = error.details
            const field = details && typeof details.field === 'string' && details.field !== '' ? details.field : null
            if (error.code === 'BAD_REQUEST' && field !== null) {
              const fieldErrors = {}
              fieldErrors[field] = settingsFieldError(t, error, field)
              pageStore.setState({ settingsSaving: false, settingsFieldErrors: fieldErrors, settingsError: null, settingsErrorSource: null })
              return
            }
            pageStore.setState({ settingsSaving: false, settingsError: error, settingsErrorSource: 'save' })
            return
          }
          const normalized = normalizeSettings(envelope)
          const nextSettings = Object.keys(normalized.settings).length > 0 ? normalized.settings : state.settings
          pageStore.setState(function (current) {
            return Object.assign({}, current, {
              settingsSaving: false,
              settingsError: null,
              settingsErrorSource: null,
              settings: nextSettings,
              settingsPersisted: normalized.persisted,
              settingsForm: settingsFormFromValues(nextSettings),
              settingsFieldErrors: {},
              settingsStatus: {
                kind: 'saved',
                persisted: normalized.persisted,
                persistError: normalized.persistError,
                warnings: normalized.warnings,
              },
            })
          })
          // The trash retention banner and the audit section read the live settings.
          loadInventory()
        }).catch(function (error) {
          if (isAbortError(error)) return
          if (requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({ settingsSaving: false, settingsError: { transport: 'network' }, settingsErrorSource: 'save' })
        })
      }

      /** Put the defaults into the form; the user still presses Save to persist them. */
      function resetSettings() {
        const state = pageStore.getSnapshot()
        if (!state.settingsDefaults) return Promise.resolve()
        pageStore.setState({
          settingsForm: settingsFormFromValues(state.settingsDefaults),
          settingsFieldErrors: {},
          settingsStatus: { kind: 'reset' },
          settingsError: null,
          settingsErrorSource: null,
        })
        return Promise.resolve()
      }

      /** Retry whichever settings request failed last (load or save). */
      function retrySettings() {
        const state = pageStore.getSnapshot()
        if (state.settingsErrorSource === 'save') return saveSettings()
        return loadSettings()
      }

      /** Arm then purge exactly the entries the Host suggested for the capacity warning. */
      function requestPurgeSuggested() {
        const state = pageStore.getSnapshot()
        if (state.actionBusy) return Promise.resolve()
        const trash = trashOf(state.inventory)
        const ids = trash && Array.isArray(trash.suggestedEntryIds) ? trash.suggestedEntryIds : []
        if (ids.length === 0) return Promise.resolve()
        if (state.confirmPurge === 'suggest') {
          if (Date.now() - (state.confirmPurgeAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runPurge(ids)
        }
        setConfirmPurge('suggest')
        return Promise.resolve()
      }

      function setRetainedConfirm(value) {
        const next = value === undefined ? null : value
        pageStore.setState({
          retainedConfirm: next,
          retainedConfirmAt: next === null ? 0 : Date.now(),
        })
      }

      /** Requeue one retained entry (`deferred.requeue`) or forget it (`deferred.cancel`). */
      function runRetainedAction(action, entryId) {
        if (pageStore.getSnapshot().retainedActionBusy) return Promise.resolve()
        if (typeof entryId !== 'string' || entryId === '') return Promise.resolve()
        lastRetainedAction = { action: action, entryId: entryId }
        const handle = requests.begin('retainedAction')
        const controller = handle.controller
        pageStore.setState({
          retainedActionBusy: { action: action, entryId: entryId },
          retainedActionError: null,
          retainedNotice: null,
          retainedConfirm: null,
          retainedConfirmAt: 0,
        })
        const path = action === 'requeue' ? ROUTE.deferredRequeue : ROUTE.deferredCancel
        return request(path, { entryIds: [entryId] }, controller.signal).then(function (envelope) {
          requests.end(handle)
          if (envelope && envelope.transport) {
            pageStore.setState({ retainedActionBusy: null, retainedActionError: { transport: envelope.transport }, retainedConfirm: null, retainedConfirmAt: 0 })
            return
          }
          if (!envelope || envelope.ok !== true) {
            pageStore.setState({ retainedActionBusy: null, retainedActionError: toApiError(envelope || {}), retainedConfirm: null, retainedConfirmAt: 0 })
            return
          }
          const changed = action === 'requeue'
            ? (typeof envelope.requeued === 'number' && isFinite(envelope.requeued) ? envelope.requeued : 0)
            : (typeof envelope.cancelled === 'number' && isFinite(envelope.cancelled) ? envelope.cancelled : 0)
          retainedNoticeSeq += 1
          // The acted-on row disappears after the reload. Hand focus to the next
          // retained row's action, else the «上次未完成» heading, else the banner
          // toggle, else the page heading (consumed by the mounted page).
          const before = pageStore.getSnapshot().deferred
          const beforeRetained = before && Array.isArray(before.retained) ? before.retained : []
          let nextRetainedId = null
          for (let i = 0; i < beforeRetained.length; i += 1) {
            const record = beforeRetained[i]
            if (!record || record.id !== entryId) continue
            const next = beforeRetained[i + 1]
            nextRetainedId = next && typeof next.id === 'string' && next.id !== '' ? next.id : null
            break
          }
          pageStore.setState({
            retainedActionBusy: null,
            retainedActionError: null,
            retainedConfirm: null,
            retainedConfirmAt: 0,
            retainedNotice: { seq: retainedNoticeSeq, kind: action, count: changed },
          })
          loadInventory()
          const reload = pageStore.getSnapshot().deferredLoaded === true ? loadDeferred() : Promise.resolve()
          Promise.resolve(reload).then(function () {
            if (disposed) return
            retainedFocusSeq += 1
            pageStore.setState({ retainedFocusRequest: { seq: retainedFocusSeq, nextEntryId: nextRetainedId } })
          })
        }).catch(function (error) {
          requests.end(handle)
          if (isAbortError(error)) return
          pageStore.setState({ retainedActionBusy: null, retainedActionError: { transport: 'network' }, retainedConfirm: null, retainedConfirmAt: 0 })
        })
      }

      function requestRetainedRequeue(entryId) {
        const state = pageStore.getSnapshot()
        if (state.retainedActionBusy) return Promise.resolve()
        const armed = state.retainedConfirm
        if (armed && armed.action === 'requeue' && armed.id === entryId) {
          if (Date.now() - (state.retainedConfirmAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runRetainedAction('requeue', entryId)
        }
        setRetainedConfirm({ action: 'requeue', id: entryId })
        return Promise.resolve()
      }

      function requestRetainedForget(entryId) {
        const state = pageStore.getSnapshot()
        if (state.retainedActionBusy) return Promise.resolve()
        const armed = state.retainedConfirm
        if (armed && armed.action === 'forget' && armed.id === entryId) {
          if (Date.now() - (state.retainedConfirmAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runRetainedAction('forget', entryId)
        }
        setRetainedConfirm({ action: 'forget', id: entryId })
        return Promise.resolve()
      }

      function retryRetainedAction() {
        const action = lastRetainedAction
        if (!action) return Promise.resolve()
        return runRetainedAction(action.action, action.entryId)
      }

      /** Focus handoff consumed by the mounted page after a retained row disappears. */
      function clearRetainedFocusRequest() {
        if (pageStore.getSnapshot().retainedFocusRequest === null) return
        pageStore.setState({ retainedFocusRequest: null })
      }

      /** Acknowledge the one-time "last startup processed entries" notice. */
      function dismissAuditNotice(at) {
        acknowledgeAuditNotice(at)
        if (pageStore.getSnapshot().auditNoticeAck === at) return
        pageStore.setState({ auditNoticeAck: at })
      }

      function measure(ids) {
        const state = pageStore.getSnapshot()
        if (state.measuring) return Promise.resolve()
        const requested = ids && typeof ids === 'object' ? ids : {}
        const workspaceIds = Array.isArray(requested.workspaceIds) ? requested.workspaceIds : []
        const sessionIds = Array.isArray(requested.sessionIds) ? requested.sessionIds : []
        if (workspaceIds.length === 0 && sessionIds.length === 0) return Promise.resolve()
        const handle = requests.begin('measure')
        const controller = handle.controller
        pageStore.setState({ measuring: true, measureError: null })
        const payload = {}
        if (workspaceIds.length > 0) payload.workspaceIds = workspaceIds
        if (sessionIds.length > 0) payload.sessionIds = sessionIds
        return request(ROUTE.measure, payload, controller.signal).then(function (envelope) {
          if (requests.stale(handle)) return
          requests.end(handle)
          if (envelope.transport || envelope.ok !== true) {
            pageStore.setState({ measuring: false, measureError: toApiError(envelope) })
            return
          }
          pageStore.setState(function (current) {
            return Object.assign({}, current, {
              measuring: false,
              measureError: null,
              measured: {
                workspaces: Object.assign({}, current.measured.workspaces, envelope.workspaces || {}),
                sessions: Object.assign({}, current.measured.sessions, envelope.sessions || {}),
              },
            })
          })
        }).catch(function (error) {
          if (isAbortError(error) || requests.stale(handle)) return
          requests.end(handle)
          pageStore.setState({ measuring: false, measureError: { transport: 'network' } })
        })
      }

      function measureUnmeasured() {
        const state = pageStore.getSnapshot()
        const inventory = state.inventory
        if (!inventory) return Promise.resolve()
        if (state.tab === 'sessions') {
          const sessions = Array.isArray(inventory.sessions) ? inventory.sessions : []
          const ids = []
          for (let i = 0; i < sessions.length; i += 1) {
            const session = sessions[i]
            const measured = state.measured.sessions[session.id]
            if (!(measured && typeof measured.bytes === 'number') && typeof session.sizeBytes !== 'number') ids.push(session.id)
          }
          return ids.length > 0 ? measure({ sessionIds: ids }) : Promise.resolve()
        }
        if (state.tab === 'workspaces') {
          const workspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : []
          const ids = []
          for (let i = 0; i < workspaces.length; i += 1) {
            const row = workspaces[i]
            const measured = state.measured.workspaces[row.id]
            if (!(measured && typeof measured.bytes === 'number')) ids.push(row.id)
          }
          return ids.length > 0 ? measure({ workspaceIds: ids }) : Promise.resolve()
        }
        return Promise.resolve()
      }

      function setTab(tab) {
        if (tab !== 'workspaces' && tab !== 'sessions' && tab !== 'trash' && tab !== 'settings') return
        const state = pageStore.getSnapshot()
        if (state.tab === tab) return
        // Switching tabs disarms a pending permanent-delete confirmation and
        // drops an announcement from a previous action so a remount cannot repeat it.
        pageStore.setState({
          tab: tab,
          confirmPurge: null,
          confirmPurgeAt: 0,
          actionError: null,
          actionNotice: null,
          deferredConfirm: null,
          deferredConfirmAt: 0,
          retainedConfirm: null,
          retainedConfirmAt: 0,
        })
        if (tab === 'trash') {
          const next = pageStore.getSnapshot()
          if (!next.trashLoaded && next.trashLoading !== true) loadTrash()
          if (trashNeedsSettings(trashOf(next.inventory))) ensureSettingsLoaded()
        }
        if (tab === 'settings') ensureSettingsLoaded()
      }

      function toggleSelect(workspaceId) {
        const state = pageStore.getSnapshot()
        const index = state.selected.indexOf(workspaceId)
        const selected = state.selected.slice()
        if (index >= 0) selected.splice(index, 1)
        else selected.push(workspaceId)
        pageStore.setState({ selected: selected })
      }

      function clearSelection() {
        pageStore.setState({ selected: [] })
      }

      function toggleSessionSelect(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const state = pageStore.getSnapshot()
        const index = state.selectedSessions.indexOf(sessionId)
        const selectedSessions = state.selectedSessions.slice()
        if (index >= 0) selectedSessions.splice(index, 1)
        else selectedSessions.push(sessionId)
        pageStore.setState({ selectedSessions: selectedSessions })
      }

      function clearSessionSelection() {
        pageStore.setState({ selectedSessions: [] })
      }

      function setSessionSort(sort) {
        if (sort !== 'newest' && sort !== 'oldest' && sort !== 'largest') return
        if (pageStore.getSnapshot().sessionSort === sort) return
        pageStore.setState({ sessionSort: sort })
      }

      function setSessionFilter(filter) {
        if (filter !== 'all' && filter !== 'archived' && filter !== 'active') return
        if (pageStore.getSnapshot().sessionFilter === filter) return
        // Rows hidden by the new filter must not stay selected for a batch deletion the user can no
        // longer see in the list; the review would show them, but clearing is the least surprising.
        pageStore.setState({ sessionFilter: filter, selectedSessions: [] })
      }

      /** Workspace filter for the Sessions tab; a narrower list restarts paging. */
      function setSessionWorkspace(workspace) {
        const value = typeof workspace === 'string' ? workspace : SESSION_WORKSPACE_ANY
        if (pageStore.getSnapshot().sessionWorkspace === value) return
        // A selection made under the previous workspace filter must not leak into a batch deletion
        // of the newly narrowed list (SPEC §10).
        pageStore.setState({ sessionWorkspace: value, sessionLimit: SESSION_PAGE_SIZE, selectedSessions: [] })
      }

      /** The "show more" limit lives in the store, so a tab switch keeps it. */
      function showMoreSessions() {
        pageStore.setState(function (current) {
          const limit = typeof current.sessionLimit === 'number' && current.sessionLimit > 0
            ? current.sessionLimit
            : SESSION_PAGE_SIZE
          return Object.assign({}, current, { sessionLimit: limit + SESSION_PAGE_SIZE })
        })
      }

      function setConfirmPurge(value) {
        const next = value === undefined ? null : value
        pageStore.setState({
          confirmPurge: next,
          confirmPurgeAt: next === null ? 0 : Date.now(),
        })
      }

      function findTrashEntry(entryId) {
        const trash = pageStore.getSnapshot().trash
        const entries = trash && Array.isArray(trash.entries) ? trash.entries : []
        for (let i = 0; i < entries.length; i += 1) {
          if (String(entries[i].id) === String(entryId)) return entries[i]
        }
        return null
      }

      /** sr-only announcement text for a successful restore/purge. */
      function makeActionNotice(kind, entryId, envelope) {
        actionNoticeSeq += 1
        if (kind === 'restore') {
          const entry = findTrashEntry(entryId)
          const title = entry
            ? (typeof entry.title === 'string' && entry.title !== '' ? entry.title : baseName(entry.originalPath))
            : ''
          return { seq: actionNoticeSeq, kind: 'restored', title: title }
        }
        const count = envelope && typeof envelope.purged === 'number' && isFinite(envelope.purged)
          ? envelope.purged
          : (entryId === 'all' ? 0 : 1)
        return { seq: actionNoticeSeq, kind: 'purged', count: count }
      }

      function runAction(kind, entryId, operation) {
        if (pageStore.getSnapshot().actionBusy) return Promise.resolve()
        lastAction = { kind: kind, entryId: entryId, operation: operation }
        const handle = requests.begin('action')
        const controller = handle.controller
        pageStore.setState({ actionBusy: { kind: kind, entryId: entryId }, actionError: null, actionNotice: null })
        return operation(controller.signal).then(function (envelope) {
          requests.end(handle)
          if (envelope && envelope.transport) {
            pageStore.setState({
              actionBusy: null,
              actionError: { transport: envelope.transport },
              confirmPurge: null,
              confirmPurgeAt: 0,
            })
            return
          }
          if (!envelope || envelope.ok !== true) {
            pageStore.setState({
              actionBusy: null,
              actionError: toApiError(envelope || {}),
              confirmPurge: null,
              confirmPurgeAt: 0,
            })
            return
          }
          pageStore.setState({
            actionBusy: null,
            actionError: null,
            confirmPurge: null,
            confirmPurgeAt: 0,
            actionNotice: makeActionNotice(kind, entryId, envelope),
          })
          // Restoring a session changes the catalog the sidebar renders;
          // use the same refresh path a dialog delete uses. The mutation bump is
          // what reloads the mounted settings page (inventory + loaded trash), so
          // an extra explicit load here would double every request.
          notifyMutation()
        }).catch(function (error) {
          requests.end(handle)
          if (isAbortError(error)) return
          pageStore.setState({
            actionBusy: null,
            actionError: { transport: 'network' },
            confirmPurge: null,
            confirmPurgeAt: 0,
          })
        })
      }

      function restoreEntry(entryId) {
        return runAction('restore', entryId, function (signal) {
          return request(ROUTE.trashRestore, { entryId: entryId }, signal)
        })
      }

      function runPurge(entryIds) {
        return runAction('purge', entryIds === null ? 'all' : entryIds[0], function (signal) {
          // SPEC §4.5: emptying the trash is explicit `{ all: true }`, never an
          // omission; the single-entry form keeps its request body on retry.
          const payload = entryIds === null ? { all: true } : { entryIds: entryIds }
          return request(ROUTE.trashPurge, payload, signal)
        })
      }

      function requestPurge(entryId) {
        const state = pageStore.getSnapshot()
        if (state.confirmPurge === entryId) {
          // The second click of a double click cannot complete the
          // irreversible action; the confirmation only counts after the cooldown.
          if (Date.now() - (state.confirmPurgeAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runPurge([entryId])
        }
        setConfirmPurge(entryId)
        return Promise.resolve()
      }

      function requestPurgeAll() {
        const state = pageStore.getSnapshot()
        if (state.confirmPurge === 'all') {
          if (Date.now() - (state.confirmPurgeAt || 0) < CONFIRM_COOLDOWN_MS) return Promise.resolve()
          return runPurge(null)
        }
        setConfirmPurge('all')
        return Promise.resolve()
      }

      function retryAction() {
        const action = lastAction
        if (!action || typeof action.operation !== 'function') return Promise.resolve()
        return runAction(action.kind, action.entryId, action.operation)
      }

      function refresh() {
        const state = pageStore.getSnapshot()
        const pending = [loadInventory()]
        if (state.tab === 'trash' || state.trashLoaded === true) pending.push(loadTrash())
        if (state.deferredLoaded === true) pending.push(loadDeferred())
        if (state.settingsLoaded === true) pending.push(loadSettings())
        return Promise.all(pending)
      }

      function disposePage() {
        disposed = true
        clearWizardDebounce()
        requests.dispose()
        lastAction = null
        lastDeferredAction = null
        lastRetainedAction = null
      }

      return {
        getSnapshot: pageStore.getSnapshot,
        subscribe: pageStore.subscribe,
        loadInventory: loadInventory,
        loadTrash: loadTrash,
        measure: measure,
        measureUnmeasured: measureUnmeasured,
        setTab: setTab,
        toggleSelect: toggleSelect,
        clearSelection: clearSelection,
        toggleSessionSelect: toggleSessionSelect,
        clearSessionSelection: clearSessionSelection,
        setSessionSort: setSessionSort,
        setSessionWorkspace: setSessionWorkspace,
        setSessionFilter: setSessionFilter,
        showMoreSessions: showMoreSessions,
        setConfirmPurge: setConfirmPurge,
        loadDeferred: loadDeferred,
        toggleDeferredExpanded: toggleDeferredExpanded,
        toggleDeferredLastRunExpanded: toggleDeferredLastRunExpanded,
        clearDeferredFocusRequest: clearDeferredFocusRequest,
        setDeferredConfirm: setDeferredConfirm,
        requestDeferredCancel: requestDeferredCancel,
        requestDeferredCancelAll: requestDeferredCancelAll,
        retryDeferredAction: retryDeferredAction,
        restoreEntry: restoreEntry,
        requestPurge: requestPurge,
        requestPurgeAll: requestPurgeAll,
        requestPurgeSuggested: requestPurgeSuggested,
        retryAction: retryAction,
        loadSettings: loadSettings,
        ensureSettingsLoaded: ensureSettingsLoaded,
        setSettingsField: setSettingsField,
        setSettingsBoolean: setSettingsBoolean,
        saveSettings: saveSettings,
        resetSettings: resetSettings,
        retrySettings: retrySettings,
        setRetainedConfirm: setRetainedConfirm,
        requestRetainedRequeue: requestRetainedRequeue,
        requestRetainedForget: requestRetainedForget,
        retryRetainedAction: retryRetainedAction,
        clearRetainedFocusRequest: clearRetainedFocusRequest,
        dismissAuditNotice: dismissAuditNotice,
        openWizard: openWizard,
        closeWizard: closeWizard,
        setWizardFilter: setWizardFilter,
        setWizardSort: setWizardSort,
        retryWizardPreview: retryWizardPreview,
        toggleWizardCandidate: toggleWizardCandidate,
        selectAllWizardCandidates: selectAllWizardCandidates,
        clearWizardSelection: clearWizardSelection,
        wizardTargets: wizardTargets,
        clearWizardFocusRequest: clearWizardFocusRequest,
        refresh: refresh,
        dispose: disposePage,
      }
    }

    /**
     * The frozen slot registrations (SPEC §7): trash glyph, review dialog, settings page.
     * @param {object} ctx - client plugin context.
     * @param {object} api - injected api object.
     * @param {Function} t - bound translator.
     */
    function registerSlotEntries(ctx, api, t) {
      const slots = ctx.slots
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        slots.inject('contextMenu.icon', function () {
          return slots.register({ name: 'contextMenu.icon', key: 'cleanup.trash' }, CleanupTrashGlyph)
        })

        // SPEC §7 item 2: the review dialog.
        slots.inject('shell.overlay', function () {
          return slots.register({
            name: 'shell.overlay',
            id: 'dsh-cleanup-dialog',
            order: 900,
            locale: NS,
            inject: function () { return { api: api } },
          }, CleanupDialog)
        })

        // SPEC §7 item 3: the storage cleanup page.
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'cleanup',
            order: 85,
            label: function () { return t('section.label') },
            locale: NS,
            inject: function () { return { api: api } },
          }, CleanupPage)
        })
      }
    }

    /**
     * The two dangerous context-menu contributions (SPEC §7 item 5). Labels are resolved
     * to strings at menu-open time because the host renders `MenuActionView.label`.
     * @param {object} ctx - client plugin context.
     * @param {{ t: Function, openDialog: Function, clearWorkspaceSessions: Function }} deps - wiring.
     */
    function registerMenuContributions(ctx, deps) {
      const t = deps.t
      const openDialog = deps.openDialog
      const clearWorkspaceSessions = deps.clearWorkspaceSessions
      const contextMenus = ctx.contextMenus
      if (contextMenus && typeof contextMenus.register === 'function') {
        // SPEC §7 item 5: session action. `resolve` receives the plain captured
        // value (never `.value`). MenuActionView.label is a string rendered as a
        // React child, so it is resolved here, on each menu opening, rather than
        // being a function (which React cannot render).
        ctx.effect(function () {
          return contextMenus.register({
            id: 'delete-session',
            target: 'session',
            order: 500,
            resolve: function (target) {
              if (!target || typeof target.sessionId !== 'string') return []
              return [{
                id: 'delete-session',
                label: t('menu.deleteSession'),
                danger: true,
                icon: { key: 'cleanup.trash' },
                separatorBefore: true,
                run: function () {
                  openDialog([{ kind: 'session', id: target.sessionId, title: target.displayTitle }])
                },
              }]
            },
          })
        }, 'dsh-cleanup: session menu action')

        ctx.effect(function () {
          return contextMenus.register({
            id: 'delete-workspace-dir',
            target: 'workspace',
            order: 400,
            resolve: function (target) {
              if (!target || typeof target.workspaceId !== 'string') return []
              return [{
                id: 'delete-workspace-dir',
                label: t('menu.deleteWorkspace'),
                danger: true,
                icon: { key: 'cleanup.trash' },
                run: function () {
                  openDialog([{
                    kind: 'workspace',
                    id: target.workspaceId,
                    title: target.displayTitle,
                    path: target.path,
                  }])
                },
              }]
            },
          })
        }, 'dsh-cleanup: workspace menu action')

        // SPEC §7 item 5: clear every Session log of a workspace without touching its folder.
        // The separator before this row groups both destructive actions at the bottom of the menu.
        ctx.effect(function () {
          return contextMenus.register({
            id: 'clear-workspace-sessions',
            target: 'workspace',
            order: 350,
            resolve: function (target) {
              if (!target || typeof target.workspaceId !== 'string') return []
              return [{
                id: 'clear-workspace-sessions',
                label: t('menu.clearWorkspaceSessions'),
                danger: true,
                icon: { key: 'cleanup.trash' },
                separatorBefore: true,
                run: function () {
                  if (typeof clearWorkspaceSessions === 'function') clearWorkspaceSessions(target)
                },
              }]
            },
          })
        }, 'dsh-cleanup: clear workspace sessions menu action')
      }
    }

    // ------------------------------------------------------------------ startup

    /**
     * Plugin entry (SPEC §7): register the locale dictionaries and slot/menu surfaces,
     * then hand every mounted component the same services and store factories.
     * @param {object} ctx - client plugin context.
     */
    function apply(ctx) {
      const locale = ctx && ctx.locale
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return

      const disposeStyles = installStyles()
      ctx.effect(function () { return disposeStyles }, 'dsh-cleanup: stylesheet')

      const t = registerLocale(ctx, locale)
      if (t === null) return

      const mutations = createMutationEmitter()
      const notifyMutation = createMutationNotifier(ctx, mutations)
      const catalog = createSessionCatalogBridge(ctx)
      const dialog = createDialogController({ ctx: ctx, mutations: mutations, notifyMutation: notifyMutation })
      const createPageStoreForMount = function () {
        return createPageStore({ t: t, notifyMutation: notifyMutation })
      }
      const api = {
        t: t,
        dialogStore: dialog.store,
        mutations: mutations,
        catalog: { getSnapshot: catalog.getSnapshot, subscribe: catalog.subscribe },
        createPageStore: createPageStoreForMount,
        openDialog: dialog.openDialog,
        closeDialog: dialog.closeDialog,
        dismissDialog: dialog.dismissDialog,
        disposeDialog: dialog.disposeDialog,
        retryDialog: dialog.retryDialog,
        deferPlan: dialog.deferPlan,
        confirmDelete: dialog.confirmDelete,
        setDialogMode: dialog.setDialogMode,
        setIncludeSessions: dialog.setIncludeSessions,
        setDialogSelection: dialog.setDialogSelection,
        invertDialogTargetSelection: dialog.invertDialogTargetSelection,
        setIncludeDescendants: dialog.setIncludeDescendants,
        selectAllDialogTargets: dialog.selectAllDialogTargets,
        setTypedText: dialog.setTypedText,
      }

      ctx.effect(function () {
        return function () {
          dialog.disposeDialog()
        }
      }, 'dsh-cleanup: dialog teardown')

      ctx.effect(function () {
        return catalog.dispose
      }, 'dsh-cleanup: session catalog bridge')

      /**
       * Context-menu entry "清空工作区会话…" (SPEC §7 item 5): pre-flight the workspace, then open
       * the ordinary review on its first batch. The dialog always opens (an empty or failed
       * pre-flight is shown inside it); only a malformed menu target answers with a toast.
       */
      function clearWorkspaceSessions(target) {
        const workspace = {
          id: target && typeof target.workspaceId === 'string' ? target.workspaceId : '',
          title: target && typeof target.displayTitle === 'string' ? target.displayTitle : '',
        }
        Promise.resolve(dialog.openWorkspaceClear(workspace)).then(function (outcome) {
          // Every other outcome is presented inside the dialog (empty pre-flight, failed pre-flight,
          // superseded); only a malformed menu target has nowhere else to go.
          if (outcome && outcome.ok !== true && outcome.reason === 'badTarget') {
            notifyContextMenu(t('menu.clearWorkspaceSessions.failed'))
          }
        }).catch(function () {
          notifyContextMenu(t('menu.clearWorkspaceSessions.failed'))
        })
      }

      /** Best-effort toast through the context-menu service; a host without it just skips it. */
      function notifyContextMenu(text) {
        const menus = ctx.contextMenus
        if (!menus || typeof menus.notify !== 'function') return
        try { menus.notify(text, false) } catch (error) { /* feedback is best effort */ }
      }

      registerSlotEntries(ctx, api, t)
      registerMenuContributions(ctx, {
        t: t,
        openDialog: dialog.openDialog,
        clearWorkspaceSessions: clearWorkspaceSessions,
      })
    }

    function initialDialogState() {
      return {
        phase: 'idle',
        // Which surface opened the review: `overlay` for the context menus, `settings` for
        // the storage-cleanup page. Only the matching copy of the dialog renders it.
        surface: 'overlay',
        // Non-null while a workspace clear walks the workspace batch by batch (SPEC §7 item 5).
        clear: null,
        // Checked targets (`kind:id`). Only the checked ones are planned; the review can narrow
        // the selection before confirming, and a workspace clear keeps the pre-flight batch.
        selection: [],
        targets: [],
        mode: 'trash',
        includeSessions: true,
        includeDescendants: true,
        plan: null,
        refreshing: false,
        typed: '',
        error: null,
        failureStage: null,
        result: null,
        deferred: null,
        // A permanent review whose planned selection grew again falls back to trash; this notice
        // explains the mode change instead of sending a plan the Host would refuse (SPEC §9).
        modeNotice: false,
        // The descendant switch was forced off because an un-checked subagent row must stay on
        // disk; the review explains it next to the switch (SPEC §9).
        descendantsAutoOff: false,
        // The settings sheet unmounted while a delete/queue request was in flight. Keep the finished
        // summary on screen when the page is reopened instead of letting the dwell timer drop it.
        keepSummary: false,
        deletingStartedAt: null,
      }
    }

    function initialPageState() {
      return {
        inventory: null,
        inventoryLoading: true,
        inventoryError: null,
        measured: { workspaces: {}, sessions: {} },
        measuring: false,
        measureError: null,
        selected: [],
        selectedSessions: [],
        sessionSort: 'newest',
        sessionWorkspace: SESSION_WORKSPACE_ANY,
        sessionFilter: 'all',
        sessionLimit: SESSION_PAGE_SIZE,
        wizardOpen: false,
        wizardFilters: defaultWizardFilters(),
        wizardSort: 'oldest',
        wizardPreview: initialWizardPreview(),
        wizardSelected: [],
        wizardNotice: null,
        wizardFocusRequest: null,
        tab: 'workspaces',
        trash: null,
        trashLoading: false,
        trashLoaded: false,
        trashError: null,
        actionBusy: null,
        actionError: null,
        actionNotice: null,
        confirmPurge: null,
        confirmPurgeAt: 0,
        deferred: null,
        deferredLoading: false,
        deferredLoaded: false,
        deferredError: null,
        deferredExpanded: false,
        deferredActionBusy: null,
        deferredActionError: null,
        deferredConfirm: null,
        deferredConfirmAt: 0,
        deferredNotice: null,
        deferredLastRunExpanded: false,
        deferredFocusRequest: null,
        retainedConfirm: null,
        retainedConfirmAt: 0,
        retainedActionBusy: null,
        retainedActionError: null,
        retainedNotice: null,
        retainedFocusRequest: null,
        settings: null,
        settingsDefaults: null,
        settingsPersisted: null,
        settingsLoading: false,
        settingsLoaded: false,
        settingsError: null,
        settingsErrorSource: null,
        settingsForm: null,
        settingsFieldErrors: {},
        settingsSaving: false,
        settingsStatus: null,
        auditNoticeAck: null,
      }
    }

    return { inject: ['slots', 'locale', 'contextMenus'], apply: apply }
  },
})
