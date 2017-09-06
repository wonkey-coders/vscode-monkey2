# Monkey2 for Visual Studio Code

This extension adds language support for the Monkey2 language to VS Code, including:

- Completion Lists (using `m2code`)
- Signature Help (using `m2getdoc` or `m2def`+`m2doc`)
- Snippets
- Quick Info (using `m2getdoc` or `m2def`+`m2doc`)
- Goto Definition (using `m2getdoc` or `m2def`+`m2doc`)
- Find References (using `guru`)
- References CodeLens
- File outline (using `m2-outline`)
- Workspace symbol search (using `m2-symbols`)
- Rename (using `m2rename`. Note: For Undo after rename to work in Windows you need to have `diff` tool in your path)
- Build-on-save (using `m2 build` and `m2 test`)
- Lint-on-save (using `m2lint` or `m2metalinter`)
- Format (using `m2returns` or `m2imports` or `m2fmt`)
- Generate unit tests skeleton (using `m2tests`)
- Add Imports (using `m2pkgs`)
- Add/Remove Tags on struct fields (using `m2modifytags`)
- Semantic/Syntactic error reporting as you type (using `m2type-live`)
- Run Tests under the cursor, in current file, in current package, in the whole workspace (using `m2 test`)
- Generate method stubs for interfaces (using `impl`)
- [_partially implemented_] Debugging (using `delve`)

## License
[MIT](LICENSE)
