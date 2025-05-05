import * as childProcess from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

const exec = promisify(childProcess.exec);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const copyFile = promisify(fs.copyFile);

export { exec, writeFile, readFile, mkdir, copyFile };
