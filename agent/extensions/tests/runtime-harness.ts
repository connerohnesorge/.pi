export type RuntimeHandler = (...args: any[]) => any;

export function createRuntimeRegistries() {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const events = new Map<string, RuntimeHandler[]>();

	return {
		commands,
		shortcuts,
		events,
		pi: {
			on(name: string, handler: RuntimeHandler) {
				const handlers = events.get(name) ?? [];
				handlers.push(handler);
				events.set(name, handlers);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut(shortcut: string, shortcutHandler: any) {
				shortcuts.set(shortcut, shortcutHandler);
			},
		},
	};
}
