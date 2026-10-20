import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
export default [
  { ignores: ["dist/**", "connector/dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.{js,jsx}", "connector/src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
