import builtins from 'rollup-plugin-node-builtins';
import resolve from 'rollup-plugin-node-resolve';
import commonJS from 'rollup-plugin-commonjs';
import json from 'rollup-plugin-json';
import legacy from 'rollup-plugin-legacy';
import globals from 'rollup-plugin-node-globals';

export default [
    {
        input: 'client.js',
        output: [
            {
                file: 'app-bundle.js',
                name: 'Client',
                format: 'iife',
                sourcemap: 'inline',
            },
        ],
        plugins: [
            legacy({
                'lib/socket.io-promise.js': 'socketPromise',
            }),
            json(),
            builtins(),
            resolve({
                browser: true,
                jsnext: true,
            }),
            commonJS({
                include: ['node_modules/**', 'config.js'],
            }),
            globals(),
        ],
    },
];
