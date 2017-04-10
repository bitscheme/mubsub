pipeline {
  agent any
  stages {
    stage('install') {
      steps {
        sh '''npm install
npm install istanbul mocha -g'''
        sh 'istanbul cover --report=json --report=html node_modules/mocha/bin/_mocha -- -t 6000 -R spec || true'
        sh 'ls coverage'
        archiveArtifacts(artifacts: 'coverage/coverage-final.json', allowEmptyArchive: true)
        publishHTML([allowMissing: true, alwaysLinkToLastBuild: false, keepAll: true, reportDir: 'coverage', reportFiles: 'index.html', reportName: 'Coverage Reports'])
      }
    }
  }
  tools {
    nodejs 'Node 6.x'
  }
}
