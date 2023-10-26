import { CfnOutput, Duration, Stack, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Vpc,
  SubnetType,
  SecurityGroup,
  Instance,
  InstanceType,
  MachineImage,
  BlockDeviceVolume,
  UserData,
  Port,
  Peer,
  FlowLogDestination,
  FlowLogTrafficType,
} from 'aws-cdk-lib/aws-ec2';
import {
  LoadBalancer,
  LoadBalancingProtocol,
} from 'aws-cdk-lib/aws-elasticloadbalancing';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  ListenerCondition,
  Protocol,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { ManagedPolicy, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  CachedMethods,
  Distribution,
  OriginProtocolPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import {
  HttpOrigin,
  LoadBalancerV2Origin,
  S3Origin,
} from 'aws-cdk-lib/aws-cloudfront-origins';
import { Role } from 'aws-cdk-lib/aws-iam';
import { ParameterDataType, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { environment } from '../constants';
import { randomUUID } from 'node:crypto';
import { InstanceIdTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';

interface AttendantIdeProps {}

export class AttendantIde extends Construct {
  public constructor(scope: Construct, id: string, _props: AttendantIdeProps) {
    super(scope, id);

    // const defaultVpc = Vpc.fromLookup(this, 'defaultVpc', { isDefault: true });
    const vpc = new Vpc(this, 'VPC', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      flowLogs: {
        VPCFlowLogs: {
          destination: FlowLogDestination.toCloudWatchLogs(),
          trafficType: FlowLogTrafficType.REJECT,
        },
      },
    });
    const instanceSecurityGroup = new SecurityGroup(this, 'instance-sg', {
      vpc,
      allowAllOutbound: true,
    });

    const idePasswordParameter = new StringParameter(this, 'ide-password', {
      dataType: ParameterDataType.TEXT,
      stringValue: 'placeholder-changed-at-deploy-time-by-ec2-user-data',
      parameterName: 'vscode-password',
    });

    const userData = UserData.forLinux();
    userData.addCommands(
      // Install general dependencies
      'yum install -y git docker jq zsh util-linux-user gcc make gcc-c++ libunwind java-17-amazon-corretto-headless unzip zip zlib zlib-devel openssl-devel ncurses-devel readline-devel bzip2-devel libffi-devel sqlite-devel xz-devel',
      // Setup docker
      'service docker start',
      'usermod -aG docker ec2-user',
      // Setup zsh and oh-my-zsh
      'chsh -s $(which zsh) ec2-user',
      `su - ec2-user -c 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended'`,
      // Download .zshrc
      // TODO: change to main branch once merged
      `su - ec2-user -c 'curl -fsSL https://raw.githubusercontent.com/aws-samples/powertools-for-aws-lambda-workshop/ec2-ide/infra/lib/attendant-ide/zshrc-sample.txt -o $HOME/.zshrc'`,
      // Install Pyenv
      `su - ec2-user -c 'curl -s https://pyenv.run | zsh'`,
      // Install fnm (Node.js)
      "su - ec2-user -c 'curl -fsSL https://fnm.vercel.app/install | zsh'",
      // Setup Python
      `su - ec2-user -c 'export PATH="/home/ec2-user/.pyenv/bin:$PATH" && eval "$(pyenv init --path)" && pyenv install 3.11.0'`,
      `su - ec2-user -c 'export PATH="/home/ec2-user/.pyenv/bin:$PATH" && eval "$(pyenv init --path)" && pyenv global 3.11.0'`,
      // Setup Node
      `su - ec2-user -c 'export PATH="/home/ec2-user/.local/share/fnm:$PATH" && eval "\`fnm env\`" && fnm install v18'`,
      `su - ec2-user -c 'exso port PATH="/home/ec2-user/.local/share/fnm:$PATH" && eval "\`fnm env\`" && fnm default v18'`,
      `su - ec2-user -c 'export PATH="/home/ec2-user/.local/share/fnm:$PATH" && eval "\`fnm env\`" && fnm use v18'`,
      // Install .NET
      'rpm -Uvh https://packages.microsoft.com/config/centos/7/packages-microsoft-prod.rpm',
      'yum install -y aspnetcore-runtime-6.0 dotnet-sdk-6.0',
      // Install Java
      'wget https://dlcdn.apache.org/maven/maven-3/3.9.5/binaries/apache-maven-3.9.5-bin.zip',
      'unzip apache-maven-3.9.5-bin.zip -d /opt',
      'ln -s /opt/apache-maven-3.9.5/ /opt/maven',
      'echo "export M2_HOME=/opt/maven" | tee /etc/profile.d/mvn.sh',
      'echo "export PATH=${M2_HOME}/bin:${PATH}" | tee -a /etc/profile.d/mvn.sh',
      'chmod a+x /etc/profile.d/mvn.sh',
      // Install AWS CLI
      "su - ec2-user -c 'curl https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o $HOME/awscliv2.zip'",
      "su - ec2-user -c 'unzip $HOME/awscliv2.zip'",
      "su - ec2-user -c 'sudo $HOME/aws/install'",
      "su - ec2-user -c 'rm -rf $HOME/awscliv2.zip $HOME/aws'",
      // Configure AWS CLI
      `su - ec2-user -c 'aws configure set region ${Stack.of(this).region}'`,
      // Configure git
      `su - ec2-user -c 'git config --global init.defaultBranch main'`,
      // Create parameter & write to config.yaml + SSM
      `su - ec2-user -c 'PASSWORD=$(uuidgen) && mkdir -p /home/ec2-user/.config/code-server && echo -e "bind-addr: 0.0.0.0:8080\nauth: password\npassword: $PASSWORD\ncert: false" > /home/ec2-user/.config/code-server/config.yaml && aws ssm put-parameter --name "vscode-password" --type "String" --value "$PASSWORD" --overwrite'`,
      // Install VSCode
      "su - ec2-user -c 'curl -fsSL https://code-server.dev/install.sh | sh'",
      'systemctl enable --now code-server@ec2-user',
      'reboot'
    );

    const vscodeInstanceRole = new Role(this, 'vscode-instance-role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonEC2RoleforSSM'
        ),
      ],
    });
    idePasswordParameter.grantWrite(vscodeInstanceRole);
    // TODO: grant to deploy Lambda + other stuff

    const vscodeInstance = new Instance(this, 'instance', {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      instanceType: new InstanceType('c6g.large'),
      machineImage: MachineImage.fromSsmParameter(
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64'
      ),
      securityGroup: instanceSecurityGroup,
      keyName: 'ee-default-keypair',
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(50),
        },
      ],
      userDataCausesReplacement: true,
      userData: userData,
      role: vscodeInstanceRole,
    });
    Tags.of(vscodeInstance).add('chronicled', 'true');
    Tags.of(vscodeInstance).add('Name', 'VSCode');

    const target = new InstanceIdTarget(vscodeInstance.instanceId, 8080);
    const loadBalancer = new ApplicationLoadBalancer(this, 'vscode-lb', {
      vpc,
      internetFacing: true,
    });

    vscodeInstance.connections.allowFrom(
      loadBalancer,
      Port.tcp(8080),
      'Allow inbound HTTP from load balancer'
    );

    const listener = loadBalancer.addListener('vscode-listener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
    });

    listener.addTargets('vscode-target', {
      port: 80,
      targets: [target],
      healthCheck: {
        path: '/healthz',
        port: '8080',
        protocol: Protocol.HTTP,
      },
      priority: 10,
      conditions: [
        ListenerCondition.httpHeader('X-VscodeServer', ['PowertoolsForAWS']),
      ],
    });
    listener.addAction('vscode-redirect', {
      action: ListenerAction.fixedResponse(403, {
        messageBody: 'Forbidden',
      }),
    });

    const distribution = new Distribution(this, 'distribution', {
      defaultBehavior: {
        origin: new HttpOrigin(loadBalancer.loadBalancerDnsName, {
          protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: {
            'X-VscodeServer': 'PowertoolsForAWS',
          },
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: new CachePolicy(this, 'ide-cache', {
          cachePolicyName: `ide-cache-${environment}`,
          minTtl: Duration.seconds(0),
          maxTtl: Duration.seconds(86400),
          defaultTtl: Duration.seconds(86400),
          cookieBehavior: CacheCookieBehavior.all(),
          headerBehavior: CacheHeaderBehavior.allowList(
            'Accept',
            'Accept-Encoding',
            'Authorization',
            'Host',
            'Origin',
            'Referrer',
            'Access-Control-Request-Method',
            'Access-Control-Request-Headers'
          ),
          queryStringBehavior: CacheQueryStringBehavior.all(),
        }),
      },
      enableIpv6: true,
      enabled: true,
    });

    new CfnOutput(this, 'IDEWorkspace', {
      value: distribution.distributionDomainName,
      description: 'The domain name where the website is hosted',
    });
  }
}
