import { resolve } from 'node:path';
import type { ScenarioManifest } from '@cua-sample/contracts';
const scenario: ScenarioManifest = {id:'browser-task',labId:'browser',category:'productivity',title:'当前浏览器任务',description:'操作独立的持久 Agent Browser',defaultPrompt:'帮我填写当前页面，提交前让我确认。',workspaceTemplatePath:resolve('fixtures/empty'),tags:['browser']};
export const listScenarios = () => [structuredClone(scenario)];
export const getScenarioById = (id:string) => id === scenario.id ? structuredClone(scenario) : undefined;
