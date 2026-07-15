//! `apply_patch` 独立可执行入口。
//!
//! 实际逻辑由 `codex_apply_patch::main` 提供，此处仅作为 bin crate 的入口点。

pub fn main() -> ! {
    codex_apply_patch::main()
}
