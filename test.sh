#!/bin/bash

echo "========> spm install - start"

npm run dev

count=`ls spm_node_modules | wc -l`
#echo $count

test $count = 19 ; echo $?

echo "========> spm install - finish"
