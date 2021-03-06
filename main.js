//Trying to avoid any npm installs or anything that takes extra time...
const   https = require('https'),
        zlib = require('zlib'),
        fs = require('fs'),
        env = process.env;

function fail(message, exitCode=1) {
    console.log(`::error::${message}`);
    process.exit(1);
}

function request(method, path, data, callback) {
    
    try {
        if (data) {
            data = JSON.stringify(data);
        }  
        const options = {
            hostname: 'api.github.com',
            port: 443,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? data.length : 0,
                'Accept-Encoding' : 'gzip',
                'Authorization' : `token ${env.INPUT_TOKEN}`,
                'User-Agent' : 'GitHub Action - development'
            }
        }
        const req = https.request(options, res => {
    
            let chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                if (res.headers['content-encoding'] === 'gzip') {
                    zlib.gunzip(buffer, (err, decoded) => {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, res.statusCode, decoded && JSON.parse(decoded));
                        }
                    });
                } else {
                    callback(null, res.statusCode, buffer.length > 0 ? JSON.parse(buffer) : null);
                }
            });
    
            req.on('error', err => callback(err));
        });
    
        if (data) {
            req.write(data);
        }
        req.end();
    } catch(err) {
        callback(err);
    }
}


function main() {

    const path = 'BUILD_NUMBER/BUILD_NUMBER';
    const prefix = env.INPUT_PREFIX ? `${env.INPUT_PREFIX}_` : '';
    var bleeding_number = env.bleeding_BUILD_NUMBER;
    var test_number = env.test_BUILD_NUMBER;
    var live_number = env.live_BUILD_NUMBER;    
	var RESET_VERSION = env.RESET_VERSION;
	var PRESERVE_VERSION = env.PRESERVE_VERSION;
	if (live_number == null) {
		live_number = 0;
	}
	if (test_number == null) {
		test_number = 0;
	}
	if (bleeding_number == null) {
		bleeding_number = 0;
	}
	if (PRESERVE_VERSION != 'YES' && PRESERVE_VERSION != 'NO') {
		fail(`The ENV:PRESERVE_VERSION variable should be YES or NO`);
	}
	if (RESET_VERSION != 'YES' && RESET_VERSION != 'NO') {
		fail(`The ENV:RESET_VERSION variable should be YES or NO`);
	}
    console.log(`Build numbers: ${bleeding_number} , ${test_number}, ${live_number}`);
    //See if we've already generated the build number and are in later steps...
    if (fs.existsSync(path)) {
        let buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated in earlier jobs, using build number ${buildNumber}...`);
        //Setting the output and a environment variable to new build number...
        console.log(`::set-env name=${prefix}BUILD_NUMBER::${buildNumber}`);
        console.log(`::set-output name=${prefix}build_number::${buildNumber}`);
        return;
    }
    
    //Some sanity checking:
    for (let varName of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
        if (!env[varName]) {
            fail(`ERROR: Environment variable ${varName} is not defined.`);
        }
    }

    request('GET', `/repos/${env.GITHUB_REPOSITORY}/git/refs/tags/${prefix}build-number-`, null, (err, status, result) => {
    
        let nextBuildNumber, nrTags;
    
        if (status === 404) {
            console.log('No build-number ref available, starting at 0.');
            nextBuildNumber = 0;
            nrTags = [];
        } else if (status === 200) {
            const regexString = `/${prefix}build-number-(\\d+)$`;
            const regex = new RegExp(regexString);
            nrTags = result.filter(d => d.ref.match(regex));
            
            const MAX_OLD_NUMBERS = 10; //One or two ref deletes might fail, but if we have lots then there's something wrong!
            if (nrTags.length > MAX_OLD_NUMBERS) {
                fail(`ERROR: Too many ${prefix}build-number- refs in repository, found ${nrTags.length}, expected only 1. Check your tags!`);
            }
            
            //Existing build numbers:
            let nrs = nrTags.map(t => parseInt(t.ref.match(/-(\d+)$/)[1]));
    
            let currentBuildNumber = Math.max(...nrs);
            console.log(`Last build nr was ${currentBuildNumber}.`);
			if (RESET_VERSION == 'YES') {
					nextBuildNumber = 0;
					console.log(`Resetting build counter to ${nextBuildNumber}...`);
			} else {
				if (PRESERVE_VERSION == 'YES') {
					nextBuildNumber = currentBuildNumber;
					console.log(`Retaining build counter as ${nextBuildNumber}...`);
				} else {
					nextBuildNumber = currentBuildNumber + 1;
					console.log(`Updating build counter to ${nextBuildNumber}...`);
				}
			}
        } else {
            if (err) {
                fail(`Failed to get refs. Error: ${err}, status: ${status}`);
            } else {
                fail(`Getting build-number refs failed with http status ${status}, error: ${JSON.stringify(result)}`);
            } 
        }

        let newRefData = {
            ref:`refs/tags/${prefix}build-number-${nextBuildNumber}`, 
            sha: env.GITHUB_SHA
        };
    
		if (PRESERVE_VERSION == 'NO') {
			request('DELETE', `/repos/${env.GITHUB_REPOSITORY}/git/${newRefData.ref}`, null, (err, status, result) => {
				if (status !== 204 || err) {
					console.log(`Failed to delete ref ${newRefData.ref}, status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
				} else {
					console.log(`Deleted ${newRefData.ref}`);
				}
			});
			request('POST', `/repos/${env.GITHUB_REPOSITORY}/git/refs`, newRefData, (err, status, result) => {
				if (status !== 201 || err) {
					fail(`Failed to create new build-number ref. Status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
				}

				console.log(`Successfully updated build number to ${nextBuildNumber}`);
				
				//Setting the output and a environment variable to new build number...
				console.log(`::set-env name=${prefix}BUILD_NUMBER::${nextBuildNumber}`);
				console.log(`::set-output name=${prefix}build_number::${nextBuildNumber}`);
				//Save to file so it can be used for next jobs...
				fs.writeFileSync('BUILD_NUMBER', nextBuildNumber.toString());
				
				
				if (PRESERVE_VERSION != 'YES') {
					//Cleanup
					if (nrTags) {
						console.log(`Deleting ${nrTags.length} older build counters...`);
					
						for (let nrTag of nrTags) {
							request('DELETE', `/repos/${env.GITHUB_REPOSITORY}/git/${nrTag.ref}`, null, (err, status, result) => {
								if (status !== 204 || err) {
									console.warn(`Failed to delete ref ${nrTag.ref}, status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
								} else {
									console.log(`Deleted ${nrTag.ref}`);
								}
							});
						}
					}
				}

			});
		} else {
				//Setting the output and a environment variable to new build number...
				console.log(`::set-env name=${prefix}BUILD_NUMBER::${nextBuildNumber}`);
				console.log(`::set-output name=${prefix}build_number::${nextBuildNumber}`);
				//Save to file so it can be used for next jobs...
				fs.writeFileSync('BUILD_NUMBER', nextBuildNumber.toString());
		}
    });
}

main();
