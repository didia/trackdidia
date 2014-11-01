'''
Created on 2014-10-30

@author: didia
'''
import datetime
import unittest

import utils


class TestUtils(unittest.TestCase):


    def testGet_week_start_and_end(self):
        monday, sunday = utils.get_week_start_and_end(today=datetime.datetime(2014,10,29))
       
        self.assertEqual(datetime.datetime(2014,10,27), monday)
        self.assertEqual(datetime.datetime(2014,11,2), sunday)


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()