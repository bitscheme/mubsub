pipeline {
  agent any
  stages {
    stage('install') {
      steps {
        sh '''npm install
npm install istanbul mocha -g'''
        sh 'istanbul cover --report=json node_modules/mocha/bin/_mocha -- -t 6000 -R spec'
        archiveArtifacts(artifacts: 'coverage/coverage-final.json', allowEmptyArchive: true)
      }
    }
  }
  tools {
    nodejs 'Node 6.x'
  }
}