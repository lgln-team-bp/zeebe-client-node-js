import { CreateWorkflowInstanceResponse, ZBClient } from '../../..'
import { createUniqueTaskType } from '../../../lib/createUniqueTaskType'

const trace = res => {
	// tslint:disable-next-line: no-console
	console.log(res)
	return res
}
process.env.ZEEBE_NODE_LOG_LEVEL = process.env.ZEEBE_NODE_LOG_LEVEL || 'NONE'
jest.setTimeout(60000)

let zbc: ZBClient
let wf: CreateWorkflowInstanceResponse | undefined

beforeEach(() => {
	zbc = new ZBClient()
})

afterEach(
	() =>
		new Promise(async resolve => {
			try {
				if (wf?.workflowInstanceKey) {
					await zbc.cancelWorkflowInstance(wf.workflowInstanceKey)
				}
			} catch (e) {
				// console.log('Caught NOT FOUND') // @DEBUG
			} finally {
				await zbc.close() // Makes sure we don't forget to close connection
				resolve(null)
			}
		})
)

test('Causes a retry with complete.failure()', () =>
	new Promise(async resolve => {
		const { bpmn, processId, taskTypes } = createUniqueTaskType({
			bpmnFilePath: './src/__tests__/testdata/Worker-Failure1.bpmn',
			messages: [],
			taskTypes: ['wait-worker-failure'],
		})

		const res = await zbc
			.deployWorkflow({
				definition: bpmn,
				name: `worker-failure-${processId}.bpmn`,
			})
			.catch(trace)

		expect(res.workflows.length).toBe(1)
		expect(res.workflows[0].bpmnProcessId).toBe(processId)

		wf = await zbc.createWorkflowInstance(processId, {
			conditionVariable: true,
		})
		const wfi = wf.workflowInstanceKey
		expect(wfi).toBeTruthy()

		await zbc.setVariables({
			elementInstanceKey: wfi,
			local: false,
			variables: {
				conditionVariable: false,
			},
		})

		zbc.createWorker(
			taskTypes['wait-worker-failure'],
			async (job, complete) => {
				// Succeed on the third attempt
				if (job.retries === 1) {
					const res1 = await complete.success()
					expect(job.workflowInstanceKey).toBe(wfi)
					expect(job.retries).toBe(1)
					wf = undefined
					resolve(null)
					return res1
				}
				return complete.failure('Triggering a retry')
			},
			{ loglevel: 'NONE' }
		)
	}))

test('Does not fail a workflow when the handler throws, by default', () =>
	new Promise(async done => {
		const { bpmn, processId, taskTypes } = createUniqueTaskType({
			bpmnFilePath: './src/__tests__/testdata/Worker-Failure2.bpmn',
			messages: [],
			taskTypes: ['console-log-worker-failure-2'],
		})
		const res = await zbc.deployWorkflow({
			definition: bpmn,
			name: `worker-failure-2-${processId}.bpmn`,
		})
		expect(res.workflows.length).toBe(1)
		expect(res.workflows[0].bpmnProcessId).toBe(processId)
		wf = await zbc.createWorkflowInstance(processId, {})

		let alreadyFailed = false
		// Faulty worker - throws an unhandled exception in task handler
		const w = zbc.createWorker(
			taskTypes['console-log-worker-failure-2'],
			async (_, complete) => {
				if (alreadyFailed) {
					await zbc.cancelWorkflowInstance(wf!.workflowInstanceKey) // throws if not found. Should NOT throw in this test
					complete.success()
					return w.close().then(() => done(null))
				}
				alreadyFailed = true
				throw new Error(
					'Unhandled exception in task handler for testing purposes'
				) // Will be caught in the library
			},
			{
				loglevel: 'NONE',
				pollInterval: 10000,
			}
		)
	}))

test('Fails a workflow when the handler throws and options.failWorkflowOnException is set', () =>
	new Promise(async done => {
		const { bpmn, taskTypes, processId } = createUniqueTaskType({
			bpmnFilePath: './src/__tests__/testdata/Worker-Failure3.bpmn',
			messages: [],
			taskTypes: ['console-log-worker-failure-3'],
		})

		const res = await zbc.deployWorkflow({
			definition: bpmn,
			name: `worker-failure-3-${processId}.bpmn`,
		})

		expect(res.workflows.length).toBe(1)
		expect(res.workflows[0].bpmnProcessId).toBe(processId)

		wf = await zbc.createWorkflowInstance(processId, {})

		let alreadyFailed = false
		// Faulty worker
		const w = zbc.createWorker(
			taskTypes['console-log-worker-failure-3'],
			job => {
				if (alreadyFailed) {
					// It polls multiple times a second, and we need it to only throw once
					return job.forward()
				}
				alreadyFailed = true
				testWorkflowInstanceExists() // waits 1000ms then checks
				throw new Error(
					'Unhandled exception in task handler for test purposes'
				) // Will be caught in the library
			},
			{
				failWorkflowOnException: true,
				loglevel: 'NONE',
			}
		)

		function testWorkflowInstanceExists() {
			setTimeout(async () => {
				try {
					await zbc.cancelWorkflowInstance(wf!.workflowInstanceKey) // throws if not found. SHOULD throw in this test
				} catch (e) {
					// deepcode ignore PromiseNotCaughtNode: test
					w.close().then(() => done(null))
				}
			}, 1500)
		}
	}))
