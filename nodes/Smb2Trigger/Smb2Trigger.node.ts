import { Client } from '@awo00/smb2';
import Tree from '@awo00/smb2/dist/client/Tree';
import File from '@awo00/smb2/dist/client/File';
import {
	type INodeType,
	type INodeTypeDescription,
	type ITriggerResponse,
	type ITriggerFunctions,
	NodeApiError,
} from 'n8n-workflow';
import { debuglog } from 'util';
import { connectToSmbServer, getReadableError } from '../Smb2/helpers';

const debug = debuglog('n8n-nodes-smb2');

// Map SMB2 actions to node events
const EVENT_MAP: Record<number, string> = {
	1: "created",      // Added
	2: "deleted",      // Removed
	3: "updated",      // Modified
};


/**
 * Waits for a file to stabilize (stop growing) before emitting an event
 */
async function waitForFileStability(
	tree: Tree,
	path: string,
	filename: string,
	action: number,
	waitDuration: number,
	emitFunc: Function,
	helpersFunc: any
): Promise<void> {
	let previousSize = BigInt(-1);

	const interval = setInterval(async () => {
		const file = new File(tree);
		try {
			const fullPath = (path + "/" + filename).replace(/\/\.\//g, '/');
			await file.open(fullPath);

			debug("Opened %s (%s)", fullPath, file.fileSize);

			// File is still growing
			if (previousSize < file.fileSize) {
				previousSize = file.fileSize;

			}
			// File size is stable
			else if (previousSize === file.fileSize) {
				debug("File %s is stable (%s)", fullPath, file.fileSize);
				clearInterval(interval);

				emitFunc([helpersFunc.returnJsonArray({
					event: EVENT_MAP[action],
					filename: filename,
					fileSize: previousSize.toString(),
					path: path,
				})]);
			}
			// File reduced to 0 - creation aborted
			else if (previousSize > 0 && file.fileSize == BigInt(0)) {
				debug("File %s aborted", fullPath);
				clearInterval(interval);
			}
		} catch (e) {
			debug("Error opening file: %s", e);
			clearInterval(interval);
		} finally {
			if (file && file.isOpen) {
				file.close();
			}
		}
	}, waitDuration);
}


/**
 * Processes a single file change event
 */
async function processFileChange(
	change: any,
	event: string,
	waitForCompletion: boolean,
	waitDuration: number,
	pendingFiles: Array<String>,
	tree: Tree,
	path: string,
	emitFunc: Function,
	helpersFunc: any
): Promise<void> {
	const action = change.action;
	const actionName = change.actionName;
	const filename = change.filename;

	debug('Action: %s | %s | Looking for: %s', action, actionName, event);

	// Check if this event type matches what we're watching for
	if (EVENT_MAP[action] != event) {
		return;
	}

	// Skip if already being processed
	if (pendingFiles.includes(filename)) {
		return;
	}

	// Handle file creation with stability check
	if (waitForCompletion && event === 'created' && !pendingFiles.includes(filename)) {
		pendingFiles.push(filename);
		await waitForFileStability(tree, path, filename, action, waitDuration, emitFunc, helpersFunc);
		return;
	}

	// Emit event for non-creation events or when not waiting for completion
	emitFunc([helpersFunc.returnJsonArray({
		event: EVENT_MAP[action],
		filename: filename,
		path: path
	})]);
}

export class Smb2Trigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Samba (SMB2) Trigger',
		name: 'smb2Trigger',
		icon: 'file:smb2.svg',
		group: ['trigger'],
		version: 1,
		description: 'Trigger a workflow on Samba (SMB2) filesystem changes',
		subtitle: '={{$parameter["event"]}}',
		defaults: {
			name: 'Samba (SMB2) Trigger',
		},
		credentials: [
			{
				// nodelinter-ignore-next-line
				name: 'smb2Api',
				required: true,
			},
		],
		inputs: [],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Trigger On',
				name: 'triggerOn',
				type: 'options',
				required: true,
				default: 'specificFolder',
				options: [
					// {
					// 	name: 'Changes to a Specific File',
					// 	value: 'specificFile',
					// },
					{
						name: 'Changes Involving a Specific Folder',
						value: 'specificFolder',
					},
					// {
					// 	name: 'Changes To Any File/Folder',
					// 	value: 'anyFileFolder',
					// },
				],
			},
			{
				displayName: 'Recursive',
				name: 'recursive',
				type: 'boolean',
				default: false,
			},
			{
				displayName: 'Wait for File Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						event: ['created'],
					},
				},
				description: 'Whether to wait until the file is fully written before triggering. Monitors file size and modification time.',
			},
			{
				displayName: 'Wait Duration (ms)',
				name: 'waitDuration',
				type: 'number',
				default: 5000,
				displayOptions: {
					show: {
						event: ['created'],
						waitForCompletion: [true],
					},
				},
				description: 'How long to wait after file creation before emitting the event (in milliseconds). This gives the file time to be fully written.',
			},
			{
				displayName: 'File',
				name: 'fileToWatch',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				modes: [
					{
						displayName: 'File',
						name: 'list',
						type: 'list',
						placeholder: 'Select a file...',
						typeOptions: {
							searchListMethod: 'fileSearch',
							searchable: true,
						},
					},
					{
						displayName: 'Path',
						name: 'path',
						type: 'string',
						placeholder: '/etc/hosts'
					},
				],
				displayOptions: {
					show: {
						triggerOn: ['specificFile'],
					},
				},
			},
			{
				displayName: 'Watch For',
				name: 'event',
				type: 'options',
				displayOptions: {
					show: {
						triggerOn: ['specificFile'],
					},
				},
				required: true,
				default: 'updated',
				options: [
					{
						name: 'File Updated',
						value: 'updated',
					},
				],
				description: 'When to trigger this node',
			},
			{
				displayName: 'Folder',
				name: 'folderToWatch',
				type: 'resourceLocator',
				default: { mode: 'path', value: '' },
				required: true,
				modes: [
					{
						displayName: 'By Path',
						name: 'path',
						type: 'string',
						placeholder: '/home/user/',
					},
				],
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
				},
			},
			{
				displayName: 'Watch For',
				name: 'event',
				type: 'options',
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
				},
				required: true,
				default: 'created',
				options: [
					{
						name: 'File Created',
						value: 'created',
						description: 'When a file is created in the watched folder',
					},
					{
						name: 'File Deleted',
						value: 'deleted',
						description: 'When a file is deleted in the watched folder',
					},
					{
						name: 'File Updated',
						value: 'updated',
						description: 'When a file is updated in the watched folder',
					},
				],
			},
			{
				displayName: "Changes within subfolders won't trigger this node",
				name: 'asas',
				type: 'notice',
				displayOptions: {
					show: {
						triggerOn: ['specificFolder'],
					},
				},
				default: '',
			},
			{
				displayName: 'Watch For',
				name: 'event',
				type: 'options',
				displayOptions: {
					show: {
						triggerOn: ['anyFileFolder'],
					},
				},
				required: true,
				default: 'created',
				options: [
					{
						name: 'File Created',
						value: 'created',
						description: 'When a file is created in the watched drive',
					},
					{
						name: 'File Updated',
						value: 'updated',
						description: 'When a file is updated in the watched drive',
					},
				],
				description: 'When to trigger this node',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const triggerOn = this.getNodeParameter('triggerOn') as string;
		const event = this.getNodeParameter('event') as string;
		const recursive = this.getNodeParameter('recursive') as boolean;
		const waitForCompletion = this.getNodeParameter('waitForCompletion', true) as boolean;
		const waitDuration = this.getNodeParameter('waitDuration', 500) as number;

		let client: Client;
		let tree: Tree;
		let closeFunction;
		let path: any;

		// Track pending files waiting for completion
		const pendingFiles = new Array<String>();

		try {
			({ client, tree } = await connectToSmbServer.call(this));

			if (triggerOn === 'specificFolder' && event !== 'watchFolderUpdated') {
				path = this.getNodeParameter('folderToWatch', '', { extractValue: true }) as string;
			} else {
				path = this.getNodeParameter('folderToWatch', '', { extractValue: true }) as string;
			}

			const stopFunction = await tree.watchDirectory(
				path,
				(response: any) => {
					try {
						// Process each change in the data array
						if (response.data && Array.isArray(response.data)) {
							// Capture this context to use in async callbacks
							const emitFunc = this.emit.bind(this);
							const helpersFunc = this.helpers;

							response.data.forEach(async (change: any) => {
								await processFileChange(
									change,
									event,
									waitForCompletion,
									waitDuration,
									pendingFiles,
									tree,
									path,
									emitFunc,
									helpersFunc
								);
							});
						}
					} catch (error) {
						debug('Error in watchDirectory callback: %s', error);
					}
				},
				recursive
			);

			closeFunction = async function () {
				pendingFiles.length = 0;

				await stopFunction();
				await client.close();
			};
		} catch (error) {
			debug('Connect error: ', error);
			const errorMessage = getReadableError(error);
			throw new NodeApiError(this.getNode(), error, { message: (`Failed to connect to SMB server: ${errorMessage}`) });
		}

		return {
			closeFunction,
		};
	}
}
