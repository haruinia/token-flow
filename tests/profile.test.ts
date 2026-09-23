import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveProfile} from '../apps/desktop/src/profile';

it('uses one populated legacy profile for all builds, preserving explicit isolation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'token-flowb-profile-'));
 try{
  expect(resolveProfile(root)).toBe(join(root,'token-flowb'));
  await mkdir(join(root,'Browser Agent'));
  await mkdir(join(root,'desktop-browser-agent','cliproxy','auth'),{recursive:true});
  expect(resolveProfile(root)).toBe(join(root,'desktop-browser-agent'));
  await mkdir(join(root,'token-flowb'));
  expect(resolveProfile(root)).toBe(join(root,'desktop-browser-agent'));
  expect(resolveProfile(root,join(root,'isolated-test'))).toBe(join(root,'isolated-test'));
 }finally{await rm(root,{recursive:true,force:true});}
});
