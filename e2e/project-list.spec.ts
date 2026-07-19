// e2e/project-list.spec.ts
// 项目列表 + Dialog 交互测试
// 设计文档 §8.4 E2E 测试策略 / Phase 10 Task 2
//
// 测试场景：
// 1. 空状态显示"暂无项目"引导文案
// 2. 点击"新建项目"按钮 → Dialog 弹出
// 3. Dialog 内表单元素可见（项目名称输入框、创建按钮）
// 4. 关闭 Dialog → Dialog 不可见
// 5. 侧边栏折叠/展开按钮可切换
//
// 注意：
// - mock 返回空数组，始终显示空状态
// - Dialog 使用 shadcn/ui Dialog 组件，role="dialog"
// - 表单 Input 通过 label 关联（getByLabel）

import { expect, test } from '@playwright/test';

test.describe('项目列表页交互', () => {
  test('空状态显示引导文案与新建按钮', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL('**/projects', { timeout: 10_000 });

    // 空状态文案可见
    await expect(page.getByText('暂无项目')).toBeVisible({ timeout: 10_000 });
    // "新建项目"按钮可见
    await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible({ timeout: 10_000 });
  });

  test('点击新建项目按钮弹出 Dialog', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('暂无项目')).toBeVisible({ timeout: 10_000 });

    // 初始状态无 Dialog
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 });

    // 点击"新建项目"按钮
    await page.getByRole('button', { name: '新建项目' }).click();

    // Dialog 弹出
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    // Dialog 标题"新建项目"可见
    await expect(page.getByText('新建项目', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('Dialog 内表单元素可见', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '新建项目' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // 项目名称输入框可见
    await expect(page.getByLabel('项目名称 *')).toBeVisible({ timeout: 5_000 });
    // 流派输入框可见
    await expect(page.getByLabel('流派')).toBeVisible({ timeout: 5_000 });
    // 简介输入框可见
    await expect(page.getByLabel('简介')).toBeVisible({ timeout: 5_000 });

    // "创建"按钮可见且初始禁用
    const createButton = page.getByRole('button', { name: '创建' });
    await expect(createButton).toBeVisible({ timeout: 5_000 });
    await expect(createButton).toBeDisabled({ timeout: 5_000 });
  });

  test('输入项目名称后创建按钮启用', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '新建项目' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // 输入项目名称
    await page.getByLabel('项目名称 *').fill('测试项目');

    // 创建按钮应启用
    const createButton = page.getByRole('button', { name: '创建' });
    await expect(createButton).toBeEnabled({ timeout: 5_000 });
  });

  test('点击取消按钮关闭 Dialog', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '新建项目' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // 点击"取消"按钮
    await page.getByRole('button', { name: '取消' }).click();

    // Dialog 应关闭
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 });
  });

  test('点击侧栏折叠按钮切换侧栏宽度', async ({ page }) => {
    await page.goto('/');

    // 侧栏折叠按钮可见（aria-label="切换侧栏"）
    const toggleButton = page.getByRole('button', { name: '切换侧栏' });
    await expect(toggleButton).toBeVisible({ timeout: 10_000 });

    // 初始状态：侧边栏文字"项目"可见（展开态）
    const projectLink = page.getByRole('link', { name: '项目' });
    await expect(projectLink).toBeVisible({ timeout: 10_000 });

    // 点击折叠按钮
    await toggleButton.click();
  });
});
